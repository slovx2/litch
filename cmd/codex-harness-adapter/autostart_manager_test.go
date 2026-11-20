package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
)

type fakeAutoManager struct {
	loadPath           string
	args               []string
	registered, active bool
	enabled, lingering bool
	fail               string
	xml                string
	mutations          []string
	spec               autostartSpec
}

const testSchedulerSID = "S-1-5-21-100-200-300-1001"

func (f *fakeAutoManager) command(_ context.Context, program string, args ...string) (string, error) {
	bad := errors.New("command failed")
	if f.fail != "" {
		return f.fail, bad
	}
	switch program {
	case "/usr/bin/systemd-run":
		f.mutations = append(f.mutations, "enqueue")
		return "", nil
	case loginctlAutostart:
		if slices.Contains(args, "enable-linger") {
			f.mutations = append(f.mutations, "linger")
			f.lingering = true
		}
		if f.lingering {
			return "yes", nil
		}
		return "no", nil
	case systemctlAutostart:
		switch verb := args[3]; verb {
		case "show":
			fi, _ := os.Stat(f.loadPath)
			if fi == nil {
				return "LoadState=not-found\nActiveState=inactive\nMainPID=0", bad
			}
			return fmt.Sprintf("LoadState=loaded\nUnitFileState=%s\nActiveState=%s\nMainPID=%d\nFragmentPath=%s\n",
				f.enabledState(), f.activeState(), f.pid(), f.loadPath), nil
		case "enable", "disable", "start", "stop", "daemon-reload", "reset-failed":
			f.mutations = append(f.mutations, verb)
			switch verb {
			case "enable":
				f.enabled = true
			case "disable":
				f.enabled, f.active = false, false
			case "start":
				f.active = true
			case "stop":
				f.active = false
			}
			return "", nil
		}
	case launchctlAutostart:
		switch verb := args[0]; verb {
		case "print":
			if !f.registered {
				return "Could not find service", bad
			}
			return fmt.Sprintf("gui/501/%s = {\n\tpath = %s\n\tstate = %s\n\tpid = %d\n\targuments = {\n\t\t%s\n\t}\n}",
				f.spec.ID, f.loadPath, f.macActiveState(), f.pid(), strings.Join(f.args, "\n\t\t")), nil
		case "print-disabled":
			return "disabled services = {\n}", nil
		case "bootstrap":
			f.mutations = append(f.mutations, verb)
			f.args = append([]string{f.spec.Executable}, f.spec.args()...)
			f.registered, f.enabled, f.active = true, true, true
			return "", nil
		case "bootout":
			f.mutations = append(f.mutations, verb)
			f.registered, f.enabled, f.active = false, false, false
			return "", nil
		case "kickstart":
			f.mutations = append(f.mutations, verb)
			f.active = true
			return "", nil
		}
	case "powershell":
		script := decodePSForTest(args[len(args)-1])
		switch {
		case strings.Contains(script, "$task.Xml"):
			state := 3
			if f.active {
				state = 4
			}
			repr, _ := json.Marshal(autoTaskInfo{XML: f.xml, Enabled: f.enabled, State: state, LastTaskResult: 1})
			return string(repr), nil
		case strings.Contains(script, "RegisterTask"):
			f.mutations = append(f.mutations, "register")
			match := regexp.MustCompile(`\$xml = .*FromBase64String\('([^']+)'\)`).FindStringSubmatch(script)
			if len(match) != 2 {
				return "", bad
			}
			raw, _ := base64.StdEncoding.DecodeString(match[1])
			f.xml, f.registered, f.enabled = string(raw), true, true
			return "", nil
		case strings.Contains(script, "DeleteTask"):
			f.mutations = append(f.mutations, "delete")
			f.xml, f.registered, f.enabled, f.active = "", false, false, false
			return "", nil
		case strings.Contains(script, ".Run("):
			f.mutations = append(f.mutations, "run")
			f.active = true
			return "", nil
		case strings.Contains(script, ".Stop("):
			f.mutations = append(f.mutations, "stop")
			f.active, f.enabled = false, false
			return "", nil
		}
	}
	return "", fmt.Errorf("unexpected %s call: %v", program, args)
}

func (f *fakeAutoManager) enabledState() string {
	if f.enabled {
		return "enabled"
	}
	return "disabled"
}

func (f *fakeAutoManager) activeState() string {
	if f.active {
		return "active"
	}
	return "inactive"
}

func (f *fakeAutoManager) macActiveState() string {
	if f.active {
		return "running"
	}
	return "exited"
}

func (f *fakeAutoManager) pid() int {
	if f.active {
		return 123
	}
	return 0
}

func decodePSForTest(raw string) string {
	blob, _ := base64.StdEncoding.DecodeString(raw)
	units := make([]uint16, len(blob)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(blob[i*2:])
	}
	return string(utf16.Decode(units))
}

func newAutoFake(t *testing.T, backend string) (*fakeAutoManager, autostartBackend) {
	t.Helper()
	base := t.TempDir()
	spec := autostartSpec{ID: "com.litch.device.fixture", Executable: filepath.Join(base, "Litch adapter"),
		Home: filepath.Join(base, "state path"), Root: filepath.Join(base, "root path"), Node: filepath.Join(base, "node")}
	f := &fakeAutoManager{spec: spec}
	switch backend {
	case "systemd":
		b := linuxAutostart{f.command, base, "501"}
		f.loadPath = b.path(spec)
		return f, b
	case "launchd":
		b := macAutostart{f.command, base, "gui/501"}
		f.loadPath = b.path(spec)
		return f, b
	default:
		return f, windowsAutostart{f.command, "powershell", testSchedulerSID}
	}
}

func TestAutostartManagerLifecycle(t *testing.T) {
	for _, name := range []string{"systemd", "launchd", "taskScheduler"} {
		t.Run(name, func(t *testing.T) {
			f, b := newAutoFake(t, name)
			ctx := context.Background()
			s := f.spec
			before := b.inspect(ctx, s)
			if before.registered || before.repair != nil {
				t.Fatalf("未安装: %+v", before)
			}
			if err := b.install(ctx, s, before); err != nil {
				t.Fatal(err)
			}
			got := b.inspect(ctx, s, s)
			if !got.registered || !got.enabled || !got.running || !got.exact || got.repair != nil {
				t.Fatalf("安装: %+v, repair=%+v", got, got.repair)
			}
			initial := len(f.mutations)
			if err := b.install(ctx, s, got); err != nil || len(f.mutations) != initial {
				t.Fatalf("重复安装改动了登记: %v, %v", err, f.mutations)
			}

			// 模拟监督器报告一次崩溃，随后监督器自己恢复。探针不得替它启动进程。
			f.active = false
			if crash := b.inspect(ctx, s, s); crash.running || !crash.enabled || len(f.mutations) != initial {
				t.Fatalf("错误地报告故障实例仍在运行: %+v", crash)
			}
			f.active = true
			if restarted := b.inspect(ctx, s, s); !restarted.running || !restarted.exact {
				t.Fatalf("未读到监督器重启: %+v", restarted)
			}

			next := s
			next.Executable += " v2"
			f.spec = next
			upgrade := b.inspect(ctx, next, s)
			if upgrade.foreign || upgrade.exact {
				t.Fatalf("旧登记的归属或版本判断错误: %+v", upgrade)
			}
			if err := b.quiesce(ctx, next); err != nil {
				t.Fatal(err)
			}
			if err := b.install(ctx, next, b.inspect(ctx, next, s)); err != nil {
				t.Fatal(err)
			}
			got = b.inspect(ctx, next, next)
			if !got.running || !got.exact || got.foreign {
				t.Fatalf("升级后运行实例不符: %+v", got)
			}
			if foreign := b.inspect(ctx, next); !foreign.foreign {
				t.Fatalf("无登记凭据却识别为本产品: %+v", foreign)
			}
			if err := b.remove(ctx, next, got); err != nil {
				t.Fatal(err)
			}
			off := b.inspect(ctx, next, next)
			if off.registered || off.running || off.enabled || off.repair != nil {
				t.Fatalf("禁用后仍然登记或运行: %+v", off)
			}
			initial = len(f.mutations)
			if err := b.remove(ctx, next, off); err != nil || len(f.mutations) != initial {
				t.Fatalf("重复关闭有副作用: %v", err)
			}
		})
	}
}

func TestAutostartManagerFailuresAndRestartPolicy(t *testing.T) {
	for _, name := range []string{"systemd", "launchd", "taskScheduler"} {
		f, b := newAutoFake(t, name)
		f.fail = "Permission denied"
		m := b.inspect(t.Context(), f.spec)
		if m.repair == nil || m.repair.Code != "permissionDenied" || b.install(t.Context(), f.spec, m) == nil || len(f.mutations) != 0 {
			t.Fatalf("%s 未在权限失败时拒绝安装: %+v", name, m)
		}
	}
	f, b := newAutoFake(t, "systemd")
	f.fail = "Failed to connect to bus: No medium found"
	if m := b.inspect(t.Context(), f.spec); m.repair == nil || m.repair.Code != "userManagerUnavailable" {
		t.Fatalf("无 user bus: %+v", m)
	}
	s := f.spec
	for _, check := range []struct{ text, contains string }{
		{linuxUnitText(s), "Restart=on-failure\nRestartSec=10s\nRestartSteps=4\nRestartMaxDelaySec=1min"},
		{linuxUnitText(s), "WantedBy=default.target"},
		{macAgentText(s), "<key>SuccessfulExit</key><false/>"},
		{macAgentText(s), "<key>ThrottleInterval</key><integer>10</integer>"},
		{(windowsAutostart{sid: testSchedulerSID}).taskXML(s.ID, s, s.args(), false), "<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count>"},
		{(windowsAutostart{sid: testSchedulerSID}).taskXML(s.ID, s, s.args(), false), "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"},
	} {
		if !strings.Contains(check.text, check.contains) || strings.Contains(check.text, "device-start") {
			t.Errorf("监督器配置缺少 %s 或执行了 device-start", check.contains)
		}
	}
}
