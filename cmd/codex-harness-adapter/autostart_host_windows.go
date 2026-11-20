package main

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"

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
