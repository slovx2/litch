package hostplatform

import (
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func Lock(file *os.File) error {
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}
func Unlock(file *os.File) {
	_ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &windows.Overlapped{})
}
func Prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}
func Kill(cmd *exec.Cmd) error {
	return exec.Command("taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
}
func Terminate(cmd *exec.Cmd) error { return Kill(cmd) }

// Job 句柄关闭时清理整个运行时进程树，包括已退出父进程的后代。
func Track(cmd *exec.Cmd) (func(), error) { return TrackPID(cmd.Process.Pid) }
func TrackPID(pid int) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(process)
	if err = windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	return func() { _ = windows.CloseHandle(job) }, nil
}
func Dial(path string) (net.Conn, error) {
	timeout := 5 * time.Second
	return winio.DialPipe(path, &timeout)
}
func CloseWrite(connection net.Conn) {
	if c, ok := connection.(interface{ CloseWrite() error }); ok {
		_ = c.CloseWrite()
	}
}
func SocketPath(home string) string {
	return fmt.Sprintf(`\\.\pipe\codex-harness-adapter-%x`, sha256.Sum256([]byte(strings.ToLower(filepath.Clean(home)))))
}
func ListenURL(path string) string   { return "pipe://" + path }
func RemoveSocket(path string) error { return nil }
func DefaultShell() string {
	if value := os.Getenv("CLAUDE_CODE_GIT_BASH_PATH"); value != "" {
		return value
	}
	for _, root := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
		candidate := filepath.Join(root, "Git", "bin", "bash.exe")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "bash.exe"
}
func ShellPath(path string) string { return filepath.ToSlash(path) }

func Protect(path string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

// 聚合面在 Windows 上是命名管道，名字由设备进程的状态目录决定。
func DeviceSocketPath(directory string) string {
	return fmt.Sprintf(`\\.\pipe\codex-harness-adapter-device-%x`, sha256.Sum256([]byte(strings.ToLower(filepath.Clean(directory)))))
}

// Detach 让子进程脱离调用方的控制台和进程组，调用方退出后继续运行。
func Detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
}

// Windows 没有可捕获的终止信号，只能直接结束。
func Stop(process *os.Process) error { return process.Kill() }

// Running 报告这个进程号上现在有没有还没退出的进程。打不开（没有这个进程，或者不是自己的）就当没有。
func Running(pid int) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	event, _ := windows.WaitForSingleObject(process, 0)
	return event == uint32(windows.WAIT_TIMEOUT)
}

// 控制通道在 Windows 上也是命名管道，名字同样由设备进程的状态目录决定。
func ControlSocketPath(directory string) string {
	return fmt.Sprintf(`\\.\pipe\codex-harness-adapter-control-%x`, sha256.Sum256([]byte(strings.ToLower(filepath.Clean(directory)))))
}

// Listen 在命名管道上监听，只让当前用户和系统访问。
func Listen(path string) (net.Listener, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GA;;;" + user.User.Sid.String() + ")"})
}
