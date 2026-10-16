//go:build !windows

package hostplatform

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func Lock(file *os.File) error            { return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func Unlock(file *os.File)                { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
func Prepare(cmd *exec.Cmd)               { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func Kill(cmd *exec.Cmd) error            { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
func Terminate(cmd *exec.Cmd) error       { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
func Track(cmd *exec.Cmd) (func(), error) { return func() {}, nil }
func Dial(path string) (net.Conn, error)  { return net.DialTimeout("unix", path, 5*time.Second) }
func CloseWrite(connection net.Conn) {
	if c, ok := connection.(*net.UnixConn); ok {
		_ = c.CloseWrite()
	}
}
func SocketPath(home string) string  { return home + "/runtime.sock" }
func ListenURL(path string) string   { return "unix://" + path }
func RemoveSocket(path string) error { return os.Remove(path) }
func DefaultShell() string {
	if value := os.Getenv("SHELL"); value != "" {
		return value
	}
	return "/bin/sh"
}
func ShellPath(path string) string { return path }
func Protect(path string) error    { return nil }

// 聚合面的套接字固定在设备进程的状态目录里。
func DeviceSocketPath(directory string) string { return directory + "/device.sock" }

// Detach 让子进程自成一个会话：没有控制终端，不在调用方的进程组里，调用方的会话（比如一次 ssh 登录）结束时不会被带走。
func Detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// Stop 请进程自己收尾后退出。
func Stop(process *os.Process) error { return process.Signal(syscall.SIGTERM) }

// Running 报告这个进程号上现在有没有进程。退出了但还没被父进程收走的（僵尸）也算有。
func Running(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// 常驻服务和设备进程之间的控制通道，和聚合面的套接字在同一个目录里。名字比 device.sock 短，
// 聚合面的套接字建得出来它就建得出来。
func ControlSocketPath(directory string) string { return directory + "/ctl.sock" }

// Listen 在本机套接字上监听，套接字文件只有属主可读写。所在的目录由调用方先收紧。
func Listen(path string) (net.Listener, error) {
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}
