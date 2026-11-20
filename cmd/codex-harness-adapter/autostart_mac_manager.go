package main

import (
	"context"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const launchctlAutostart = "/bin/launchctl"

type macAutostart struct {
	run              autostartCommand
	userHome, domain string
}

func (macAutostart) name() string { return "launchd" }
func (b macAutostart) path(s autostartSpec) string {
	return filepath.Join(b.userHome, "Library", "LaunchAgents", s.ID+".plist")
}

func autoXML(s string) string {
	var result strings.Builder
	_ = xml.EscapeText(&result, []byte(s))
	return result.String()
}

func launchAgentText(label, executable, cwd string, arguments []string, keep bool) string {
	text := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>` + autoXML(label) + `</string>
<key>WorkingDirectory</key><string>` + autoXML(cwd) + `</string>
<key>ProgramArguments</key><array>`
	for _, arg := range append([]string{executable}, arguments...) {
		text += "<string>" + autoXML(arg) + "</string>"
	}
	text += "</array>\n<key>RunAtLoad</key><true/>\n"
	if keep {
		text += "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n" +
			"<key>ThrottleInterval</key><integer>10</integer>\n<key>ExitTimeOut</key><integer>50</integer>\n"
	}
	return text + "</dict></plist>\n"
}

func macAgentText(s autostartSpec) string {
	return launchAgentText(s.ID, s.Executable, s.Root, s.args(), true)
}

func launchdFields(raw string) (map[string]string, []string) {
	var args []string
	var fields []string
	inArgs := false
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "\t\t") && inArgs {
			args = append(args, strings.TrimPrefix(line, "\t\t"))
		} else if strings.HasPrefix(line, "\t") && !strings.HasPrefix(line, "\t\t") {
			inArgs = strings.TrimSpace(line) == "arguments = {"
			fields = append(fields, line)
		}
	}
	return autoProperties(strings.Join(fields, "\n")), args
}

func (b macAutostart) inspect(ctx context.Context, s autostartSpec, owned ...autostartSpec) autostartManagerState {
	m := autostartManagerState{linger: "notApplicable"}
	file, ours, exact, err := autoFileStatus(b.path(s), macAgentText, s, owned...)
	if err != nil {
		m.repair = autoAccess()
		return m
	}
	m.registered, m.exact = file, exact
	if file && !ours {
		m.foreign, m.repair = true, autoConflict()
		return m
	}
	raw, err := b.run(ctx, launchctlAutostart, "print", b.domain+"/"+s.ID)
	if err == nil {
		p, args := launchdFields(raw)
		m.registered = true
		loadedOurs := slices.ContainsFunc(owned, func(old autostartSpec) bool {
			return old.ID != "" && slices.Equal(args, append([]string{old.Executable}, old.args()...))
		})
		if !ours || p["path"] != b.path(s) || !loadedOurs {
			m.foreign, m.repair = true, autoConflict()
			return m
		}
		m.exact = m.exact && slices.Equal(args, append([]string{s.Executable}, s.args()...))
		m.running = p["state"] == "running"
		m.pid, _ = strconv.Atoi(p["pid"])
	} else if autoPermissionError(raw) {
		m.repair = autoAccess()
		return m
	} else if !strings.Contains(strings.ToLower(raw), "could not find service") {
		m.repair = autoRepair("userManagerUnavailable", "无法连接 launchd 的图形登录域；请先登录该设备的系统账号。", "Cannot connect to the launchd login domain. Sign in to the device's system account.")
		return m
	}
	disabled, err := b.run(ctx, launchctlAutostart, "print-disabled", b.domain)
	if err != nil {
		m.repair = autoAccess()
		return m
	}
	override := autoProperties(strings.ReplaceAll(disabled, "=>", "="))[`"`+s.ID+`"`]
	m.overrideDisabled = override == "disabled" || override == "true"
	m.enabled = file && strings.Contains(raw, " = {") && !m.overrideDisabled
	return m
}

func (b macAutostart) install(ctx context.Context, s autostartSpec, m autostartManagerState) error {
	if m.foreign || m.repair != nil {
		return autoManagerFailure(m.repair)
	}
	target := b.domain + "/" + s.ID
	if m.registered && (!m.exact || !m.enabled) {
		if err := b.bootout(ctx, target); err != nil {
			return err
		}
	}
	if !m.exact {
		if err := writeAutoRegistration(b.path(s), macAgentText(s), m.registered); err != nil {
			return err
		}
	}
	if !m.enabled || !m.exact {
		if m.overrideDisabled {
			if _, err := b.run(ctx, launchctlAutostart, "enable", target); err != nil {
				return err
			}
		}
		_, err := b.run(ctx, launchctlAutostart, "bootstrap", b.domain, b.path(s))
		return err
	}
	if !m.running {
		_, err := b.run(ctx, launchctlAutostart, "kickstart", target)
		return err
	}
	return nil
}

func (b macAutostart) bootout(ctx context.Context, target string) error {
	if raw, err := b.run(ctx, launchctlAutostart, "print", target); err != nil {
		if strings.Contains(strings.ToLower(raw), "could not find service") {
			return nil
		}
		return err
	}
	_, err := b.run(ctx, launchctlAutostart, "bootout", target)
	return err
}

func (b macAutostart) remove(ctx context.Context, s autostartSpec, m autostartManagerState) error {
	if m.foreign || m.repair != nil {
		return autoManagerFailure(m.repair)
	}
	if !m.registered {
		return nil
	}
	if err := b.bootout(ctx, b.domain+"/"+s.ID); err != nil {
		return err
	}
	if err := os.Remove(b.path(s)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (b macAutostart) quiesce(ctx context.Context, s autostartSpec) error {
	return b.bootout(ctx, b.domain+"/"+s.ID)
}

func (macAutostart) linger(context.Context) error { return nil }

func macWorker(s autostartSpec, revision int64) (label, path, text string) {
	label = autoWorkerID(s, revision)
	path = filepath.Join(s.Home, "device", label+".plist")
	return label, path, launchAgentText(label, s.Executable, s.Root, autoWorkerArgs(s, revision), false)
}

func (b macAutostart) enqueue(ctx context.Context, s autostartSpec, revision int64) error {
	label, path, text := macWorker(s, revision)
	_, err := os.Lstat(path)
	if err == nil {
		raw, readErr := os.ReadFile(path)
		if readErr != nil || string(raw) != text {
			return autoManagerFailure(autoConflict())
		}
		if err := b.bootout(ctx, b.domain+"/"+label); err != nil {
			return err
		}
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := writeAutoRegistration(path, text, !errors.Is(err, os.ErrNotExist)); err != nil {
		return err
	}
	if _, err := b.run(ctx, launchctlAutostart, "bootstrap", b.domain, path); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func (b macAutostart) cleanupWorker(ctx context.Context, s autostartSpec, revision int64) {
	label, path, _ := macWorker(s, revision)
	// bootout 可能先结束这个进程。
	_ = os.Remove(path)
	_ = b.bootout(ctx, b.domain+"/"+label)
}
