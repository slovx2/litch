//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// 握手是第一行；输入写得进去、回显和命令的输出读得回来；退出码是命令的退出码。
func TestPtyBridgeHandshakeEchoAndExitCode(t *testing.T) {
	bridge := startPtyScript(t, `read line; echo "got:$line"; exit 7`)
	pid := bridge.pid()
	bridge.input("hello\n")
	if code, _ := bridge.exit(10 * time.Second); code != 7 {
		t.Fatalf("退出码是 %d，应为 7", code)
	}
	// 回显开着：敲进去的字先原样回来，然后才是命令自己的输出。
	if text := bridge.text(); text != "hello\ngot:hello\n" {
		t.Fatalf("输出不对: %q", text)
	}
	expectPtyGroupGone(t, pid)
}

// 初始大小在命令起来之前就定好；改大小之后终端报的是新的，前台的进程收到 SIGWINCH；不合规矩的大小不理会。
func TestPtyBridgeInitialSizeAndResize(t *testing.T) {
	// 每收到一次 SIGWINCH 报一次大小。等的时候用 sleep 不用 read：read 被信号打断之后各家 shell 的做法不一样。
	script := `trap 'stty size' WINCH; stty size; echo ready; while :; do sleep 0.05; done`
	bridge := startPtyBridge(t, nil, "", "--rows", "7", "--cols", "13", "--", "/bin/sh", "-c", script)
	bridge.pid()
	bridge.expect("7 13\nready\n")
	bridge.send(map[string]any{"action": "resize", "rows": 30, "cols": 100})
	bridge.expect("30 100\n")
	for _, bad := range []map[string]any{
		{"action": "resize", "rows": 70000, "cols": 10},
		{"action": "resize", "rows": -1, "cols": 10},
		{"action": "resize", "rows": "9", "cols": 9},
		{"action": "resize", "rows": 9},
	} {
		bridge.send(bad)
	}
	bridge.send(map[string]any{"action": "resize", "rows": 31, "cols": 101})
	bridge.expect("31 101\n")
	bridge.send(map[string]any{"action": "kill"})
	if code, _ := bridge.exit(10 * time.Second); code != 1 {
		t.Fatalf("退出码是 %d", code)
	}
	// 指令是按次序做的：不合规矩的那几条要是被用上了，两次之间会多报出别的大小。
	if text := bridge.text(); text != "7 13\nready\n30 100\n31 101\n" {
		t.Fatalf("终端报的大小不对: %q", text)
	}
}

// 不给大小就是 24 行 80 列。
func TestPtyBridgeDefaultSize(t *testing.T) {
	bridge := startPtyBridge(t, nil, "", "--", "/bin/sh", "-c", "stty size")
	bridge.pid()
	if code, _ := bridge.exit(10 * time.Second); code != 0 || bridge.text() != "24 80\n" {
		t.Fatalf("退出码 %d 输出 %q", code, bridge.text())
	}
}

// 命令自成会话和进程组，握手报的进程号就是组号；三个标准流都是终端，而且是它的控制终端。
func TestPtyBridgeSessionGroupAndControllingTerminal(t *testing.T) {
	script := `test -t 0 && test -t 1 && test -t 2 && echo three-ttys; echo via-ctty >/dev/tty; echo "self=$$"; read l`
	bridge := startPtyScript(t, script)
	pid := bridge.pid()
	bridge.expect("self=" + strconv.Itoa(pid) + "\n")
	if text := bridge.text(); !strings.Contains(text, "three-ttys\n") || !strings.Contains(text, "via-ctty\n") {
		t.Fatalf("标准流不是终端，或者没有控制终端: %q", text)
	}
	group, groupErr := unix.Getpgid(pid)
	session, sessionErr := unix.Getsid(pid)
	if groupErr != nil || sessionErr != nil || group != pid || session != pid {
		t.Fatalf("进程 %d 的进程组是 %d、会话是 %d（%v %v），都应该是它自己", pid, group, session, groupErr, sessionErr)
	}
	// 桥自己不在这个会话里。
	if own, err := unix.Getsid(bridge.command.Process.Pid); err != nil || own == pid {
		t.Fatalf("桥和命令在同一个会话里: %d %v", own, err)
	}
	bridge.input("\n")
	if code, _ := bridge.exit(10 * time.Second); code != 0 {
		t.Fatalf("退出码是 %d", code)
	}
}

// 环境和工作目录原样继承桥的；参数原样交给命令，第一项不换成全路径；命令按桥的 PATH 找。
func TestPtyBridgeInheritsEnvironmentDirectoryAndArguments(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tool := filepath.Join(directory, "show-arguments")
	script := "#!/bin/sh\npwd -P\necho \"foo=$FOO term=[$TERM] lang=[$LANG]\"\nfor a in \"$@\"; do echo \"arg=$a\"; done\n"
	if err := os.WriteFile(tool, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	environment := []string{"FOO=bar baz", "TERM=", "LANG=en_US.UTF-8", "LC_ALL=", "LC_CTYPE=", "PATH=" + directory + ":" + os.Getenv("PATH")}
	bridge := startPtyBridge(t, environment, directory, "--rows", "5", "--cols", "40", "--", "show-arguments", "带 空格", "--rows", "-x", "")
	bridge.pid()
	if code, _ := bridge.exit(10 * time.Second); code != 0 {
		t.Fatalf("退出码是 %d，输出 %q", code, bridge.text())
	}
	// TERM 给的是空的就是空的，桥不替命令补。
	want := directory + "\nfoo=bar baz term=[] lang=[en_US.UTF-8]\narg=带 空格\narg=--rows\narg=-x\narg=\n"
	if text := bridge.text(); text != want {
		t.Fatalf("输出不对:\n%q\n应为\n%q", text, want)
	}
}

// eof 指令写的是一个 Ctrl-D：读终端的命令读到头，终端本身还在。
func TestPtyBridgeEndOfInput(t *testing.T) {
	bridge := startPtyScript(t, `stty -echo; echo ready; cat; echo "cat-done:$?"`)
	bridge.pid()
	bridge.expect("ready\n")
	bridge.input("abc\n")
	bridge.expect("abc\n")
	bridge.send(map[string]any{"action": "eof"})
	if code, _ := bridge.exit(10 * time.Second); code != 0 || bridge.text() != "ready\nabc\ncat-done:0\n" {
		t.Fatalf("退出码 %d 输出 %q", code, bridge.text())
	}
}

// 认不出的行、不合规矩的值都跳过，桥不因为一条坏指令停下。
func TestPtyBridgeSkipsMalformedCommands(t *testing.T) {
	bridge := startPtyScript(t, `stty -echo; echo ready; read l; echo "got:$l"`)
	bridge.pid()
	bridge.expect("ready\n")
	for _, line := range []string{"不是 JSON\n", "{\"action\":\"input\",\"data\":\"***\"}\n", "{\"action\":\"nope\"}\n", "[1,2]\n", "\n", "{\"action\":\"input\"}\n"} {
		if _, err := bridge.stdin.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	bridge.input("still-here\n")
	if code, _ := bridge.exit(10 * time.Second); code != 0 || bridge.text() != "ready\ngot:still-here\n" {
		t.Fatalf("退出码 %d 输出 %q", code, bridge.text())
	}
}

// 大量输出一个字节不丢、次序不乱；一条输出最多是一次读到的 65536 字节。
func TestPtyBridgeLargeOutputIsCompleteAndOrdered(t *testing.T) {
	const count = 20000
	script := `stty -onlcr; i=0; while [ $i -lt ` + strconv.Itoa(count) + ` ]; do echo "line-$i-abcdefghijklmnopqrstuvwxyz"; i=$((i+1)); done; exit 3`
	bridge := startPtyScript(t, script)
	bridge.pid()
	if code, _ := bridge.exit(60 * time.Second); code != 3 {
		t.Fatalf("退出码是 %d", code)
	}
	var want strings.Builder
	for i := 0; i < count; i++ {
		want.WriteString("line-" + strconv.Itoa(i) + "-abcdefghijklmnopqrstuvwxyz\n")
	}
	if text := bridge.text(); text != want.String() {
		t.Fatalf("输出和写出来的不一样：%d 字节，应为 %d 字节", len(text), want.Len())
	}
	if bridge.largest > ptyReadSize {
		t.Fatalf("有一条输出是 %d 字节，超过了一次读的上限", bridge.largest)
	}
}

// 写完就退出：留在终端里还没读走的那一截不丢。
func TestPtyBridgeOutputWrittenJustBeforeExitIsKept(t *testing.T) {
	const size = 400000
	bridge := startPtyScript(t, `head -c `+strconv.Itoa(size)+` /dev/zero | tr '\0' x; exit 4`)
	bridge.pid()
	if code, _ := bridge.exit(60 * time.Second); code != 4 {
		t.Fatalf("退出码是 %d", code)
	}
	if text := bridge.text(); text != strings.Repeat("x", size) {
		t.Fatalf("输出是 %d 字节，应为 %d 字节的 x", len(text), size)
	}
}

// 命令里的管道照常被 SIGPIPE 结束：桥自己接着这个信号，但不能把“忽略”传给命令。
func TestPtyBridgeLeavesSigpipeAtDefault(t *testing.T) {
	bridge := startPtyScript(t, `(yes; echo "yes-exit=$?" >&2) | head -1 >/dev/null; sleep 0.2`)
	bridge.pid()
	if code, _ := bridge.exit(10 * time.Second); code != 0 || bridge.text() != "yes-exit=141\n" {
		t.Fatalf("退出码 %d 输出 %q", code, bridge.text())
	}
}
