package main

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func autostartPlatformIdentity() (string, string, error) {
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return "", "", err
	}
	info, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", "", err
	}
	return dir, info.User.Sid.String(), nil
}

func autostartLockContended(err error) bool { return errors.Is(err, windows.ERROR_LOCK_VIOLATION) }

// 受管服务的环境：系统目录加登记的 Node 所在目录。
func autostartServiceEnv(node string) []string {
	env := autostartBaseEnv()
	for index, entry := range env {
		if strings.HasPrefix(entry, "PATH=") {
			env[index] = entry + string(os.PathListSeparator) + filepath.Dir(node)
		}
	}
	return env
}

func autostartBaseEnv() []string {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return []string{}
	}
	root := filepath.Dir(system)
	env := []string{"SystemRoot=" + root, "WINDIR=" + root, "ComSpec=" + filepath.Join(system, "cmd.exe"), "PATH=" + system}
	if account, err := user.Current(); err == nil {
		env = append(env, "USERPROFILE="+account.HomeDir, "USERNAME="+account.Username)
	}
	for _, key := range []string{"LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "ProgramData", "PATHEXT", "HOMEDRIVE", "HOMEPATH"} {
		if v := os.Getenv(key); v != "" {
			env = append(env, key+"="+v)
		}
	}
	return env
}
