package main

import (
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/slovx2/litch/internal/hostplatform"
)

func absolute(t *testing.T, path string) string {
	t.Helper()
	result, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func envOf(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func parseOK(t *testing.T, env map[string]string, stdin string, argv ...string) machineCommand {
	t.Helper()
	command, err := parseMachineArgs(argv, envOf(env), strings.NewReader(stdin))
	if err != nil {
		t.Fatalf("%v: %v", argv, err)
	}
	return command
}

func TestMachineArgsMapToTools(t *testing.T) {
	cases := []struct {
		argv  []string
		stdin string
		tool  string
		args  map[string]any
	}{
		{[]string{"machines"}, "", "machines", map[string]any{}},
		{[]string{"exec", "--cwd", "/tmp", "--yield-ms=500", "ls", "-la", "--json"}, "", "exec",
			map[string]any{"command": "ls -la --json", "cwd": "/tmp", "yield_ms": 500}},
		// -- 之后的都是命令，哪怕像选项
		{[]string{"exec", "--machine", "session", "--timeout-ms", "9000", "--", "grep", "--json", "x"}, "", "exec",
			map[string]any{"command": "grep --json x", "machine": "session", "timeout_ms": 9000}},
		{[]string{"exec", "--stdin", "-", "cat"}, "hello", "exec", map[string]any{"command": "cat", "stdin": "hello"}},
		{[]string{"ps", "p3"}, "", "process", map[string]any{"process_id": "p3", "action": "read"}},
		{[]string{"ps", "p3", "signal", "--signal", "term"}, "", "process",
			map[string]any{"process_id": "p3", "action": "signal", "signal": "SIGTERM"}},
		{[]string{"ps", "p3", "read", "--wait-ms", "100", "--after-seq", "7"}, "", "process",
			map[string]any{"process_id": "p3", "action": "read", "wait_ms": 100, "after_seq": 7}},
		{[]string{"ps", "p3", "write", "--input", "-"}, "y\n", "process",
			map[string]any{"process_id": "p3", "action": "write", "input": "y\n"}},
		{[]string{"read", "~/a.txt", "--offset", "10", "--length", "20"}, "", "read_file",
			map[string]any{"path": "~/a.txt", "offset": 10, "length": 20}},
		{[]string{"write", "/tmp/b", "--mode", "append"}, "body", "write_file",
			map[string]any{"path": "/tmp/b", "mode": "append", "content": "body"}},
		{[]string{"write", "/tmp/b", "--content", "x"}, "ignored", "write_file",
			map[string]any{"path": "/tmp/b", "content": "x"}},
		{[]string{"ls", "/", "--depth", "2"}, "", "list_dir", map[string]any{"path": "/", "depth": 2}},
		{[]string{"cp", "session:/tmp/a", "desktop:~/b"}, "", "copy", map[string]any{
			"from": map[string]any{"machine": "session", "path": "/tmp/a"},
			"to":   map[string]any{"machine": "desktop", "path": "~/b"},
		}},
	}
	for _, c := range cases {
		command := parseOK(t, nil, c.stdin, c.argv...)
		if command.tool != c.tool || !reflect.DeepEqual(command.args, c.args) {
			t.Errorf("%v → %s %#v，应为 %s %#v", c.argv, command.tool, command.args, c.tool, c.args)
		}
	}
}

func TestMachineArgsRejectMistakes(t *testing.T) {
	for _, argv := range [][]string{
		{"frobnicate"},
		{"exec"},
		{"exec", "--bogus", "ls"},
		{"exec", "--timeout-ms", "soon", "ls"},
		{"exec", "--cwd"},
		{"machines", "extra"},
		{"ps"},
		{"ps", "p1", "eat"},
		{"ps", "p1", "write"},
		{"read"},
		{"write", "/x", "--mode", "replace"},
		{"cp", "/tmp/a", "desktop:/b"},
		{"cp", "session:", "desktop:/b"},
		{"exec", "--json=yes", "ls"},
	} {
		_, err := parseMachineArgs(argv, envOf(nil), strings.NewReader(""))
		if _, ok := err.(*machineUsageError); !ok {
			t.Errorf("%v 应当是用法错误，得到 %v", argv, err)
		}
	}
}

func TestMachineThreadAndSocket(t *testing.T) {
	command := parseOK(t, map[string]string{"CODEX_THREAD_ID": "codex-1"}, "", "machines")
	if command.thread != "codex-1" {
		t.Fatalf("thread = %q", command.thread)
	}
	command = parseOK(t, map[string]string{"CODEX_THREAD_ID": "codex-1", "LITCH_THREAD_ID": "litch-1"}, "", "machines")
	if command.thread != "litch-1" {
		t.Fatalf("LITCH_THREAD_ID 应当优先，得到 %q", command.thread)
	}
	command = parseOK(t, map[string]string{"LITCH_THREAD_ID": "litch-1"}, "", "machines", "--thread", "given")
	if command.thread != "given" {
		t.Fatalf("--thread 应当优先，得到 %q", command.thread)
	}
	command = parseOK(t, map[string]string{deviceSocketEnvironment: "/s/device.sock"}, "", "machines")
	if command.socket != "/s/device.sock" {
		t.Fatalf("socket = %q", command.socket)
	}
	command = parseOK(t, map[string]string{deviceSocketEnvironment: "/s/device.sock"}, "", "machines", "--home", "/h")
	if want := hostplatform.DeviceSocketPath(filepath.Join(absolute(t, "/h"), "device")); command.socket != want {
		t.Fatalf("--home 应当优先，得到 %q", command.socket)
	}
	command = parseOK(t, nil, "", "ls", "/", "--json", "--desktop", "mac")
	if !command.json || command.desktop != "mac" {
		t.Fatalf("%+v", command)
	}
}

func TestMachineExecOutcome(t *testing.T) {
	cases := []struct {
		text, output string
		notes        int
		code         int
	}{
		{"status: exited\nexit_code: 3\nduration_ms: 12\nseq: 6\noutput:\nhello\n", "hello\n", 0, 3},
		{"status: exited\nexit_code: 0\nseq: 0\noutput:\n", "", 0, 0},
		{"process_id: p2\nstatus: still running after 500 ms. Use process …\nseq: 4\noutput so far:\nabc", "abc", 2, machineExitRunning},
		{"status: timed out after 1000 ms and was killed (exit code 124)\nduration_ms: 1000\nseq: 0\noutput:\nx", "x", 1, 124},
		{"status: killed\nseq: 0\noutput:\n", "", 1, 137},
		{"status: unknown: Litch lost the connection\nseq: 0\noutput:\n", "", 1, machineExitFailed},
		// 认不出样子：整段当输出
		{"something else", "something else", 0, 0},
		// 输出里也有像标签的行，只认第一个
		{"exit_code: 1\noutput:\noutput:\nexit_code: 9", "output:\nexit_code: 9", 0, 1},
	}
	for _, c := range cases {
		output, notes, code := execOutcome(c.text)
		if output != c.output || len(notes) != c.notes || code != c.code {
			t.Errorf("%q → %q %v %d", c.text, output, notes, code)
		}
	}
}

func TestMachineFailureExit(t *testing.T) {
	for kind, code := range map[string]int{
		"noExecutor": machineExitNoDesktop, "ambiguous": machineExitAmbiguous, "declined": machineExitDeclined,
		"disabled": machineExitDisabled, "blocked": machineExitBlocked, "invalid": machineExitUsage,
		"permission": machineExitPermission, "failed": machineExitFailed, "whatever": machineExitFailed,
	} {
		response := machineResponse{}
		response.ContentItems = append(response.ContentItems, struct {
			Type     string `json:"type"`
			Text     string `json:"text,omitempty"`
			ImageURL string `json:"imageUrl,omitempty"`
		}{Type: "inputText", Text: "[litch:" + kind + "] 说明"})
		if got := failureExit(response); got != code {
			t.Errorf("%s → %d，应为 %d", kind, got, code)
		}
	}
}

// 会话号的几个来源按先后认；Pi、dsh 给命令的会话号就是入口的会话号
func TestMachineThreadFallbacks(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"PI_SESSION_ID": "pi-1"}, "pi-1"},
		{map[string]string{"DSH_SESSION_ID": "dsh-1"}, "dsh-1"},
		{map[string]string{"DSH_SESSION_ID": "dsh-1", "PI_SESSION_ID": "pi-1"}, "pi-1"},
		{map[string]string{"PI_SESSION_ID": "pi-1", "CODEX_THREAD_ID": "codex-1"}, "codex-1"},
		{map[string]string{}, ""},
	}
	for _, c := range cases {
		if got := parseOK(t, c.env, "", "machines").thread; got != c.want {
			t.Fatalf("%v：得到 %q，应当是 %q", c.env, got, c.want)
		}
	}
}

// 外面带进来的会话号不往运行时、设备进程里传；设备进程拿到设备服务的套接字
func TestMachineThreadVariablesAreNotInherited(t *testing.T) {
	cfg := testConfiguration(t)
	for _, name := range machineThreadVariables {
		t.Setenv(name, "stale")
	}
	t.Setenv(deviceSocketEnvironment, "/from/process")
	cfg.userEnv = map[string]string{"PI_SESSION_ID": "file"}
	for label, entries := range map[string][]string{"runtime": cfg.environment(), "device": cfg.serviceEnvironment()} {
		values := map[string]string{}
		for _, entry := range entries {
			name, value, _ := strings.Cut(entry, "=")
			if _, duplicate := values[name]; duplicate {
				t.Fatalf("%s：环境变量重复 %s", label, name)
			}
			values[name] = value
		}
		for _, name := range machineThreadVariables {
			if _, ok := values[name]; ok {
				t.Fatalf("%s：%s 不该传下去", label, name)
			}
		}
		if values[deviceSocketEnvironment] != cfg.deviceSocket() {
			t.Fatalf("%s：套接字是 %q", label, values[deviceSocketEnvironment])
		}
	}
}

// 沙箱拦下的连接（EPERM）要说清楚是沙箱，让模型去申请提权；原话里的 operation not permitted 是 codex 认沙箱拒绝的依据
func TestMachineUnreachableHint(t *testing.T) {
	sandboxed := &deviceUnreachable{socket: "/s", err: &net.OpError{Op: "dial", Net: "unix", Err: os.NewSyscallError("connect", syscall.EPERM)}}
	if hint := unreachableHint(sandboxed); !strings.Contains(hint, "沙箱") {
		t.Fatalf("EPERM：%q", hint)
	}
	if !strings.Contains(strings.ToLower(sandboxed.Error()), "operation not permitted") {
		t.Fatalf("原话里要有 operation not permitted：%q", sandboxed.Error())
	}
	if hint := unreachableHint(&deviceUnreachable{err: syscall.EACCES}); !strings.Contains(hint, "别的用户") {
		t.Fatalf("EACCES：%q", hint)
	}
	if hint := unreachableHint(&deviceUnreachable{err: syscall.ENOENT}); !strings.Contains(hint, "没在运行") {
		t.Fatalf("ENOENT：%q", hint)
	}
}
