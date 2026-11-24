//go:build !windows

package main

import (
	"errors"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

func autostartPlatformIdentity() (string, string, error) { return "", "", nil }

func autostartLockContended(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

// 调用服务管理器只要系统目录。
var autostartSystemPath = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}

// 受管服务额外要带的标准安装位置：npm 与 Homebrew 的全局目录，排在系统目录前面，与登录 shell 的次序一致。
// 手动 start 继承登录环境，这几处通常都在；自启的环境由我们拼，不补就找不到装在这里的 harness 和它们要跑的命令。
var autostartStandardPath = func() []string {
	if runtime.GOOS == "darwin" {
		return []string{"/opt/homebrew/bin", "/usr/local/bin"}
	}
	return []string{"/usr/local/bin"}
}

func autostartBaseEnv() []string { return autostartEnv(autostartSystemPath) }

// 受管服务的环境：标准安装位置、系统目录、官方安装脚本常用的 ~/.local/bin，最后是登记的 Node 所在目录
// （带 /usr/bin/env node 的已安装入口也能执行）。结果不取决于登记的是系统的 Node 还是随包带的那一份。
func autostartServiceEnv(node string) []string {
	path := append(autostartStandardPath(), autostartSystemPath...)
	if current, err := user.Current(); err == nil {
		path = append(path, filepath.Join(current.HomeDir, ".local", "bin"))
	}
	return autostartEnv(append(path, filepath.Dir(node)))
}

func autostartEnv(path []string) []string {
	env := []string{"LC_ALL=C"}
	if current, err := user.Current(); err == nil {
		env = append(env, "HOME="+current.HomeDir, "USER="+current.Username, "LOGNAME="+current.Username)
		if runtime.GOOS == "linux" {
			dir := "/run/user/" + current.Uid
			env = append(env, "XDG_RUNTIME_DIR="+dir, "DBUS_SESSION_BUS_ADDRESS=unix:path="+dir+"/bus")
		}
	}
	return append(env, "PATH="+strings.Join(path, ":"))
}
