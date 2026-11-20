//go:build !windows

package main

import (
	"errors"
	"os/user"
	"runtime"
	"strings"
	"syscall"
)

func autostartPlatformIdentity() (string, string, error) { return "", "", nil }

func autostartLockContended(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

func autostartBaseEnv() []string {
	path := []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}
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
