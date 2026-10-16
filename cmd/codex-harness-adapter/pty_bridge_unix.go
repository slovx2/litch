//go:build !windows

package main

import (
	"errors"
	"flag"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// 伪终端的字节桥：语义对齐 Codex 的 codex-utils-pty（portable-pty）。带终端的命令和进程
// （command/exec、process/* 带 tty，以及设备上可重连的终端）由 packages/shared/src/process-rpc.mts
// 起成 `codex-harness-adapter pty-bridge --rows N --cols M -- <命令…>`，两边在标准输入输出上说一行一条的 JSON。
// Windows 上是 pty_bridge_windows.go，协议相同。
//
// 桥写出去的：
//
//	{"event":"spawned","pid":N}             命令已经 exec 成功。N 是它的进程号，也是它的进程组号
//	{"event":"spawnError","message":"…"}    没起来，随后以 127 退出
//	{"stream":"stdout","delta":"<base64>"}  终端上的输出，一次读到的（最多 65536 字节）一条
//
// 桥读进来的：
//
//	{"action":"input","data":"<base64>"}    写进终端
//	{"action":"resize","rows":N,"cols":M}   改终端的大小
//	{"action":"eof"}                        写一个 Ctrl-D
//	{"action":"kill"}                       结束
//
// 几条规矩：
//   - 命令自成一个会话和进程组，伪终端是它的控制终端；环境和工作目录原样继承桥的。
//   - 结束（kill 指令、SIGTERM、SIGINT、标准输入结束）立刻给整个进程组发 SIGKILL，不先发 SIGTERM。
//   - 命令退出后最多再等 2 秒把输出读完，然后把进程组里剩下的收掉。
//   - 退出码就是命令的退出码；命令是被信号结束的，退出码是 1（portable-pty 的规矩）。
const (
	ptyDrainTimeout = 2 * time.Second
	ptyReadSize     = 65536
	ptySizeLimit    = 65535
)

func runPtyBridge(args []string) int {
	out := &ptyBridgeOutput{}
	fail := func(message string) int {
		out.event(map[string]any{"event": "spawnError", "message": message})
		return 127
	}
	flags := flag.NewFlagSet("pty-bridge", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	rows, cols := flags.Int("rows", 24, "行数"), flags.Int("cols", 80, "列数")
	if err := flags.Parse(args); err != nil {
		return fail(err.Error())
	}
	command := flags.Args()
	if len(command) == 0 {
		return fail("command must not be empty")
	}
	if !ptySizeValid(*rows) || !ptySizeValid(*cols) {
		return fail("无效终端参数")
	}
	path, err := lookPtyCommand(command[0])
	if err != nil {
		return fail(command[0] + ": " + err.Error())
	}
	master, slave, err := pty.Open()
	if err != nil {
		return fail(err.Error())
	}
	defer master.Close()
	// 大小在命令起来之前就定好，它一开始读到的就是对的。
	if err := pty.Setsize(slave, &pty.Winsize{Rows: uint16(*rows), Cols: uint16(*cols)}); err != nil {
		_ = slave.Close()
		return fail(err.Error())
	}
	// 信号在起命令之前就接住，起来之后再处理：不留“命令已经在跑、桥却被默认处置带走”的空当。
	// SIGPIPE 也接住，但什么都不做：对面先关了的话，往标准输出写只是报错，由 ptyBridgeOutput 去结束命令。
	// 不能改成忽略它：被忽略的信号会原样传给命令，命令里的管道就不会被 SIGPIPE 结束了。
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGPIPE)
	// 自成会话（顺带自成进程组，组号就是进程号），伪终端的从端接到它的标准输入输出上并设为控制终端。
	// 工作目录原样继承，环境也是（只有语言环境那一处例外，见 ptyCommandEnvironment）；
	// 参数原样交过去，第一项不换成找到的全路径。
	process, err := os.StartProcess(path, command, &os.ProcAttr{
		Env:   ptyCommandEnvironment(),
		Files: []*os.File{slave, slave, slave},
		Sys:   &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0},
	})
	_ = slave.Close()
	if err != nil {
		return fail(command[0] + ": " + ptyErrorText(err))
	}
	pid := process.Pid
	kill := func() { _ = syscall.Kill(-pid, syscall.SIGKILL) }
	out.broken = kill
	out.event(map[string]any{"event": "spawned", "pid": pid})

	go func() {
		for received := range signals {
			if received != syscall.SIGPIPE {
				kill()
			}
		}
	}()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		buffer := make([]byte, ptyReadSize)
		for {
			n, err := master.Read(buffer)
			if n > 0 {
				out.output(buffer[:n])
			}
			// 从端全关了：macOS 上是读到头，Linux 上是 EIO。都是输出结束。
			if err != nil {
				return
			}
		}
	}()
	writes := newPtyBridgeWrites()
	go writes.run()
	go readPtyBridgeCommands(os.Stdin, master, writes, kill)

	state, waitErr := process.Wait()
	select {
	case <-drained:
	case <-time.After(ptyDrainTimeout):
	}
	// 到这里不再往外发输出；进程组里剩下的（后台的孙进程）一并收掉。
	out.stop()
	reapPtyGroup(pid)
	out.close()
	if waitErr != nil {
		return 1
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Exited() {
		return status.ExitStatus()
	}
	return 1
}

// 行数和列数都要在 1 到 65535 之间（系统里存它们的是 16 位无符号数）。指令里漏写的那一项读出来是 0，也算不合规矩。
func ptySizeValid(value int) bool { return value >= 1 && value <= ptySizeLimit }

// 把进程组收干净：发 SIGKILL，直到组里没有活的为止。
// 只发一次不够：macOS 上组里的进程正在 fork 时，刚生出来的那个可能没被这一次信号算进去，
// 它的父进程死了，它留了下来。所以发完隔一小会儿再看，还有就再发；一共最多等四分之一秒。
// 组里已经没有进程（或者只剩还没被收走的僵尸）时系统会报错，那就是收干净了。
func reapPtyGroup(pid int) {
	for wait := time.Millisecond; wait <= 128*time.Millisecond; wait *= 2 {
		if syscall.Kill(-pid, syscall.SIGKILL) != nil {
			return
		}
		time.Sleep(wait)
	}
}

// 照 execvp 的规矩找可执行文件：名字里带斜杠就原样用；否则挨个目录试 PATH，PATH 没设时是 /bin:/usr/bin，
// 空的一项是当前目录。标准库的 exec.LookPath 在这两处不一样（没设 PATH 就一个都不找，相对目录里找到的不认），
// 而桥要的是和原来一样：客户端可以把 PATH 去掉，用户的 PATH 里也可以有当前目录。
func lookPtyCommand(name string) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	search, ok := os.LookupEnv("PATH")
	if !ok {
		search = "/bin:/usr/bin"
	}
	var denied error
	for _, directory := range strings.Split(search, ":") {
		candidate := "./" + name
		if directory != "" {
			candidate = filepath.Join(directory, name)
		}
		info, err := os.Stat(candidate)
		switch {
		case errors.Is(err, syscall.ENOENT), errors.Is(err, syscall.ENOTDIR):
			continue
		case err != nil:
			err = errors.Unwrap(err)
		case info.IsDir():
			err = syscall.EACCES
		default:
			if err = unix.Access(candidate, unix.X_OK); err == nil {
				return candidate, nil
			}
		}
		// 有同名的但用不了：接着往后找，都找不到时报头一个这样的原因，不报“没有这个文件”。
		if denied == nil {
			denied = err
		}
	}
	if denied != nil {
		return "", denied
	}
	return "", syscall.ENOENT
}

// 起进程失败时只留系统给的原因，不带标准库加的“fork/exec 路径”前缀（路径调用方自己写）。
func ptyErrorText(err error) string {
	var failure *os.PathError
	if errors.As(err, &failure) {
		return failure.Err.Error()
	}
	return err.Error()
}
