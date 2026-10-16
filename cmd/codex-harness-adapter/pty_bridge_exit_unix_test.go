//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 连 TERM、HUP、INT 都不理的一组进程：前面一个，后台一个。收得掉它们，说明发的是 SIGKILL，而且是发给整个组的。
const ptyStubbornScript = `trap '' TERM HUP INT; (trap '' TERM HUP INT; sleep 300) & echo up; wait`

// 三种结束方式（kill 指令、桥收到 SIGTERM 或 SIGINT、标准输入结束）都立刻收掉整个进程组，退出码是 1。
func TestPtyBridgeTerminationKillsWholeGroup(t *testing.T) {
	ways := map[string]func(*ptyBridgeSession){
		"kill 指令": func(bridge *ptyBridgeSession) { bridge.send(map[string]any{"action": "kill"}) },
		"SIGTERM": func(bridge *ptyBridgeSession) { _ = bridge.command.Process.Signal(syscall.SIGTERM) },
		"SIGINT":  func(bridge *ptyBridgeSession) { _ = bridge.command.Process.Signal(syscall.SIGINT) },
		"标准输入结束":  func(bridge *ptyBridgeSession) { _ = bridge.stdin.Close() },
		"指令只写了半行": func(bridge *ptyBridgeSession) {
			_, _ = bridge.stdin.Write([]byte(`{"action":"in`))
			_ = bridge.stdin.Close()
		},
	}
	for name, end := range ways {
		t.Run(name, func(t *testing.T) {
			bridge := startPtyScript(t, ptyStubbornScript)
			pid := bridge.pid()
			bridge.expect("up\n")
			asked := time.Now()
			end(bridge)
			code, _ := bridge.exit(10 * time.Second)
			if took := time.Since(asked); code != 1 || took > 1500*time.Millisecond {
				t.Fatalf("退出码 %d（应为 1），用了 %v（应当立刻）", code, took)
			}
			expectPtyGroupGone(t, pid)
		})
	}
}

// 命令是被信号结束的，退出码是 1（portable-pty 的规矩），不是 128 加信号值。
func TestPtyBridgeSignalledCommandExitsOne(t *testing.T) {
	for _, signal := range []string{"TERM", "KILL", "SEGV"} {
		bridge := startPtyScript(t, "kill -"+signal+" $$")
		bridge.pid()
		if code, _ := bridge.exit(10 * time.Second); code != 1 {
			t.Fatalf("被 SIG%s 结束时退出码是 %d，应为 1", signal, code)
		}
	}
}

// 命令起不来：第一行就是 spawnError，没有别的行，退出码 127。
func TestPtyBridgeSpawnFailures(t *testing.T) {
	directory := t.TempDir()
	plain := filepath.Join(directory, "plain")
	if err := os.WriteFile(plain, []byte("not executable\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		args    []string
		message string
	}{
		{"路径不存在", []string{"--", "/nonexistent/dir/command"}, "/nonexistent/dir/command: no such file or directory"},
		{"PATH 里找不到", []string{"--", "no-such-command-for-pty-bridge"}, "no-such-command-for-pty-bridge: no such file or directory"},
		{"不可执行的文件", []string{"--", plain}, plain + ": permission denied"},
		{"目录", []string{"--", directory}, directory + ": permission denied"},
		{"空命令", []string{"--rows", "5", "--cols", "5", "--"}, "command must not be empty"},
		{"空命令，不带分隔", []string{}, "command must not be empty"},
		{"大小越界", []string{"--rows", "70000", "--cols", "5", "--", "/bin/sh"}, "无效终端参数"},
		{"大小是 0", []string{"--rows", "5", "--cols", "0", "--", "/bin/sh"}, "无效终端参数"},
		{"大小不是数", []string{"--rows", "many", "--", "/bin/sh"}, ""},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			bridge := startPtyBridge(t, nil, "", item.args...)
			first := bridge.handshake()
			message, _ := first["message"].(string)
			if first["event"] != "spawnError" || message == "" || (item.message != "" && message != item.message) {
				t.Fatalf("第一行不对: %v", first)
			}
			if code, _ := bridge.exit(10 * time.Second); code != 127 || bridge.lines != 1 {
				t.Fatalf("退出码 %d（应为 127），一共 %d 行（应为 1）", code, bridge.lines)
			}
		})
	}
}

// 命令退出时后台还留着一个抓着终端的进程。它先把 HUP 挡住，前面的才退出：
// 会话的头一个进程退出时，系统会给前台进程组发 HUP。
const ptyLingeringScript = `(trap '' HUP; sleep 0.7; echo late; sleep 300) & sleep 0.2; echo early; exit 5`

// 命令退出后最多再等 2 秒把输出读完，然后把进程组里剩下的收掉；退出码仍是命令的。
//
// 两种系统在这里不一样，桥只是照着系统给的来：
// Linux 上后台的进程还能接着往终端写，所以晚到的输出读得到，桥等满 2 秒；
// macOS 上会话的头一个进程一退出，系统就把这个终端从所有进程手里收回，输出当场到头，桥不用等。
func TestPtyBridgeDrainsLateOutputForTwoSeconds(t *testing.T) {
	bridge := startPtyScript(t, ptyLingeringScript)
	pid := bridge.pid()
	bridge.expect("early\n")
	left := time.Now()
	code, _ := bridge.exit(10 * time.Second)
	took := time.Since(left)
	if code != 5 {
		t.Fatalf("退出码是 %d，应为 5", code)
	}
	expectPtyGroupGone(t, pid)
	if runtime.GOOS == "linux" {
		if text := bridge.text(); text != "early\nlate\n" {
			t.Fatalf("晚到的输出没有读到: %q", text)
		}
		if took < 1800*time.Millisecond || took > 4*time.Second {
			t.Fatalf("命令退出后桥又过了 %v 才退出，应当是 2 秒上下", took)
		}
		return
	}
	if text := bridge.text(); text != "early\n" || took > 1500*time.Millisecond {
		t.Fatalf("输出 %q，命令退出后桥又过了 %v 才退出", text, took)
	}
}

// 后台的进程一直在写：到 2 秒就不再读了，不会被它拖着不退出。
func TestPtyBridgeDrainStopsAfterTwoSeconds(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("命令退出后终端还能接着写是 Linux 的行为，macOS 上输出当场到头（上一条用例）")
	}
	bridge := startPtyScript(t, `(trap '' HUP; while :; do echo tick; sleep 0.1; done) & sleep 0.2; echo early; exit 5`)
	pid := bridge.pid()
	bridge.expect("early\n")
	left := time.Now()
	code, _ := bridge.exit(10 * time.Second)
	if took := time.Since(left); code != 5 || took < 1800*time.Millisecond || took > 4*time.Second {
		t.Fatalf("退出码 %d，命令退出后桥又过了 %v 才退出", code, took)
	}
	// 退出之后读到的 tick 大约是 2 秒的量，不是没有，也不是没完没了。
	after := bridge.text()[strings.Index(bridge.text(), "early\n"):]
	if ticks := strings.Count(after, "tick\n"); ticks < 10 || ticks > 30 {
		t.Fatalf("命令退出后读到 %d 个 tick，2 秒里应当是 20 个上下", ticks)
	}
	expectPtyGroupGone(t, pid)
}

// 命令已经退出、桥还在等输出的时候，结束的要求照样立刻生效，不用等满 2 秒。
func TestPtyBridgeTerminationDuringDrain(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("macOS 上命令一退出输出就到头，没有“还在等输出”这一段")
	}
	ways := map[string]func(*ptyBridgeSession){
		"kill 指令": func(bridge *ptyBridgeSession) { bridge.send(map[string]any{"action": "kill"}) },
		"SIGTERM": func(bridge *ptyBridgeSession) { _ = bridge.command.Process.Signal(syscall.SIGTERM) },
		"标准输入结束":  func(bridge *ptyBridgeSession) { _ = bridge.stdin.Close() },
	}
	for name, end := range ways {
		t.Run(name, func(t *testing.T) {
			bridge := startPtyScript(t, `(trap '' HUP; sleep 300) & sleep 0.2; echo early; exit 6`)
			pid := bridge.pid()
			bridge.expect("early\n")
			time.Sleep(300 * time.Millisecond)
			asked := time.Now()
			end(bridge)
			code, _ := bridge.exit(10 * time.Second)
			if took := time.Since(asked); code != 6 || took > time.Second {
				t.Fatalf("退出码 %d（应为 6），用了 %v（应当立刻）", code, took)
			}
			expectPtyGroupGone(t, pid)
		})
	}
}

// 命令把标准流都关了还在跑：输出到头不等于结束，桥等到它真的退出，退出码照旧。
func TestPtyBridgeWaitsForCommandAfterOutputCloses(t *testing.T) {
	bridge := startPtyScript(t, `echo closing; exec >/dev/null 2>&1 </dev/null; sleep 1; exit 9`)
	bridge.pid()
	code, took := bridge.exit(10 * time.Second)
	if code != 9 || took < 900*time.Millisecond || bridge.text() != "closing\n" {
		t.Fatalf("退出码 %d，用了 %v，输出 %q", code, took, bridge.text())
	}
}

// 命令不读输入、终端的输入队列写满了，往里写就停在那里。这时结束的要求仍然立刻生效，输出也照常出来。
func TestPtyBridgeTerminationWhileInputIsBlocked(t *testing.T) {
	// 许多行、每行都完整：队列里有读得走的整行而没人读，再写就会堵住。
	flood := strings.Repeat(strings.Repeat("x", 63)+"\n", 256)
	ways := map[string]func(*ptyBridgeSession){
		"kill 指令": func(bridge *ptyBridgeSession) { bridge.send(map[string]any{"action": "kill"}) },
		"SIGTERM": func(bridge *ptyBridgeSession) { _ = bridge.command.Process.Signal(syscall.SIGTERM) },
		"标准输入结束":  func(bridge *ptyBridgeSession) { _ = bridge.stdin.Close() },
	}
	for name, end := range ways {
		t.Run(name, func(t *testing.T) {
			bridge := startPtyScript(t, `stty -echo; echo up; sleep 1; echo still-out; sleep 300`)
			pid := bridge.pid()
			bridge.expect("up\n")
			bridge.input(flood)
			bridge.expect("still-out\n")
			asked := time.Now()
			end(bridge)
			code, _ := bridge.exit(10 * time.Second)
			if took := time.Since(asked); code != 1 || took > 1500*time.Millisecond {
				t.Fatalf("退出码 %d（应为 1），用了 %v（应当立刻）", code, took)
			}
			expectPtyGroupGone(t, pid)
		})
	}
}

// 对面先把读输出的那一头关了：桥写不出去，就把命令结束掉，不留它在那里空跑。
func TestPtyBridgeClosedOutputEndsCommand(t *testing.T) {
	bridge := startPtyScript(t, `trap '' TERM HUP INT; echo up; while :; do echo tick; sleep 0.05; done`)
	pid := bridge.pid()
	bridge.expect("up\n")
	_ = bridge.stdout.Close()
	select {
	case <-bridge.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("读输出的那一头关了，桥没有退出")
	}
	if bridge.code != 1 {
		t.Fatalf("退出码是 %d，应为 1", bridge.code)
	}
	expectPtyGroupGone(t, pid)
}
