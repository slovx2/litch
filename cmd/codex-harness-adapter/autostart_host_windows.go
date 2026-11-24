package main

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
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

// 受管服务的环境：PATH 照登录环境取注册表里系统和用户的 Path，npm 全局目录里的 codex.cmd、Git 等
// 与手动 start 一样找得到（拼法见 windowsAutostartPath）。在清掉继承的环境之前调用，%VAR% 按任务计划程序给的环境展开。
func autostartServiceEnv(node string) []string {
	env := autostartBaseEnv()
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return env
	}
	paths := []string{
		readRegistryPath(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`),
		readRegistryPath(registry.CURRENT_USER, `Environment`),
	}
	profile := ""
	if account, err := user.Current(); err == nil {
		profile = account.HomeDir
	}
	path := windowsAutostartPath(system, paths, os.Getenv("APPDATA"), profile, node)
	for index, entry := range env {
		if strings.HasPrefix(entry, "PATH=") {
			env[index] = "PATH=" + path
		}
	}
	return env
}

// 读不到（键或值不存在、没有权限）是空串：PATH 仍有 System32 和保底的几处。
func readRegistryPath(root registry.Key, path string) string {
	key, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, kind, err := key.GetStringValue("Path")
	if err != nil {
		return ""
	}
	if kind == registry.EXPAND_SZ {
		if expanded, err := registry.ExpandString(value); err == nil {
			value = expanded
		}
	}
	return value
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
