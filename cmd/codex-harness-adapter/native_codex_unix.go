//go:build !windows

package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// Unix 上 app-server 直接听在这个 harness 平常的套接字上，设备进程照常连它，用不着转发（Windows 见 native_codex_windows.go）。
func codexSocketPath(c configuration) string      { return c.socket() }
func dialCodex(c configuration) (net.Conn, error) { return hostplatform.Dial(c.socket()) }
func bridgeCodex(configuration) (func(), error)   { return func() {}, nil }

// 上一次的服务要是被强杀了（来不及收尾），它起的 codex app-server 会留下来：没有人管它，
// 它却还占着 codex 自己给这个套接字加的锁，新起的那个会报“control socket is already in use”起不来（实测）。
// 适配器自己的运行时没有这个问题（各听各的套接字文件，旧的只是留着没人连）。
// 所以每次起 app-server 都把它的进程号记在状态目录里，下次起之前先把上次留下的收掉。
// 调用时拿着这个 harness 的状态锁：这个状态目录上没有别的服务，记着的进程只可能是留下来没人管的。

func codexPidPath(c configuration) string { return filepath.Join(c.directory(), "runtime.pid") }

var codexOrphanGrace = 5 * time.Second

func recordCodexProcess(c configuration, pid int) {
	_ = os.WriteFile(codexPidPath(c), []byte(strconv.Itoa(pid)), 0o600)
}

func forgetCodexProcess(c configuration) { _ = os.Remove(codexPidPath(c)) }

// 记着的那个进程组里，还有没有命令行带着我们这个套接字的进程。
// 进程号可能已经被别的进程用了，所以不能只看号：app-server 是自成一组起的（组号就是记下的进程号），
// 命令行里带着 `--listen unix://<我们的套接字>`，两样都对上才是它。
func codexOrphanAlive(c configuration, group int) bool {
	output, err := exec.Command("ps", "-axww", "-o", "pgid=,command=").Output()
	if err != nil {
		return false
	}
	listen := hostplatform.ListenURL(c.socket())
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != strconv.Itoa(group) {
			continue
		}
		if strings.Contains(line, listen) {
			return true
		}
	}
	return false
}

func reapCodexOrphan(c configuration) {
	data, err := os.ReadFile(codexPidPath(c))
	if err != nil {
		return
	}
	defer forgetCodexProcess(c)
	group, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || group <= 1 || !codexOrphanAlive(c, group) {
		return
	}
	_ = syscall.Kill(-group, syscall.SIGTERM)
	for deadline := time.Now().Add(codexOrphanGrace); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if !codexOrphanAlive(c, group) {
			return
		}
	}
	_ = syscall.Kill(-group, syscall.SIGKILL)
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline) && codexOrphanAlive(c, group); {
		time.Sleep(50 * time.Millisecond)
	}
}

// 没在用原生 codex 的时候（停用着）也看一眼：上一次的服务被强杀时它可能正开着。
// 拿得到这个 harness 的状态锁才动手：拿不到说明这个状态目录上另有服务在管它。
func sweepCodexOrphan(c configuration) {
	if _, err := os.Stat(codexPidPath(c)); err != nil {
		return
	}
	lock, err := os.OpenFile(filepath.Join(c.directory(), "serve.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return
	}
	defer lock.Close()
	if hostplatform.Lock(lock) != nil {
		return
	}
	defer hostplatform.Unlock(lock)
	reapCodexOrphan(c)
}
