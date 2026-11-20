package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const systemctlAutostart = "/usr/bin/systemctl"
const loginctlAutostart = "/usr/bin/loginctl"

type linuxAutostart struct {
	run           autostartCommand
	userHome, uid string
}

func (linuxAutostart) name() string    { return "systemd" }
func linuxUnit(s autostartSpec) string { return s.ID + ".service" }

func (b linuxAutostart) path(s autostartSpec) string {
	return filepath.Join(b.userHome, ".config", "systemd", "user", linuxUnit(s))
}

func linuxUnitText(s autostartSpec) string {
	quote := func(arg string) string {
		// systemd 对整个命令还有一层 $ 和 % 展开。: 只禁用 $，% 要在所有字段转义。
		return "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "\t", "\\t").Replace(arg) + "\""
	}
	args := append([]string{s.Executable}, s.args()...)
	for i, arg := range args {
		args[i] = quote(arg)
	}
	// WorkingDirectory 接收原始路径（含空格），不按 ExecStart 的规则切词。
	work := strings.ReplaceAll(s.Root, "%", "%%")
	return "[Unit]\nDescription=Litch device (" + s.ID + ")\nStartLimitIntervalSec=3min\nStartLimitBurst=5\n\n" +
		"[Service]\nType=simple\nWorkingDirectory=" + work + "\nExecStart=:" + strings.Join(args, " ") +
		"\nRestart=on-failure\nRestartSec=10s\nRestartSteps=4\nRestartMaxDelaySec=1min\nTimeoutStopSec=50s\n\n[Install]\nWantedBy=default.target\n"
}

func (b linuxAutostart) call(ctx context.Context, args ...string) (string, error) {
	return b.run(ctx, systemctlAutostart, append([]string{"--user", "--no-pager", "--no-ask-password"}, args...)...)
}

func (b linuxAutostart) inspect(ctx context.Context, s autostartSpec, owned ...autostartSpec) autostartManagerState {
	m := autostartManagerState{linger: "unavailable"}
	if result, err := b.run(ctx, loginctlAutostart, "--no-ask-password", "show-user", b.uid, "-p", "Linger", "--value"); err == nil {
		switch result {
		case "yes":
			m.linger = "enabled"
		case "no":
			m.linger = "disabled"
		}
	}
	file, ours, exact, err := autoFileStatus(b.path(s), linuxUnitText, s, owned...)
	if err != nil {
		m.repair = autoAccess()
		return m
	}
	m.registered, m.exact = file, exact
	if file && !ours {
		m.foreign, m.repair = true, autoConflict()
	}
	raw, queryErr := b.call(ctx, "show", "-p", "LoadState,ActiveState,UnitFileState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload,Result", linuxUnit(s))
	p := autoProperties(raw)
	if p["LoadState"] == "" || (queryErr != nil && p["LoadState"] != "not-found") {
		if m.foreign {
			return m
		}
		switch {
		case autoPermissionError(raw):
			m.repair = autoAccess()
		case errors.Is(queryErr, os.ErrNotExist):
			m.repair = autoRepair("managerUnavailable", "此设备没有 systemd 用户服务管理器。", "No systemd user service manager is available on this device.")
		default:
			m.repair = autoRepair("userManagerUnavailable", "无法连接 systemd 用户服务管理器；请先登录该设备的系统账号。", "Cannot connect to the systemd user manager. Sign in to the device's system account.")
		}
		return m
	}
	if (p["FragmentPath"] != "" && (p["FragmentPath"] != b.path(s) || !ours)) ||
		p["DropInPaths"] != "" || p["LoadState"] == "masked" {
		m.registered, m.foreign, m.repair = true, true, autoConflict()
	}
	m.enabled = p["UnitFileState"] == "enabled"
	m.running = p["ActiveState"] == "active"
	m.pid, _ = strconv.Atoi(p["MainPID"])
	if m.repair == nil && p["NeedDaemonReload"] == "yes" && m.registered {
		m.exact = false
	}
	return m
}

func (b linuxAutostart) install(ctx context.Context, s autostartSpec, m autostartManagerState) error {
	if m.foreign || m.repair != nil {
		return autoManagerFailure(m.repair)
	}
	if m.exact && m.enabled && m.running {
		return nil
	}
	if !m.exact {
		if err := writeAutoRegistration(b.path(s), linuxUnitText(s), m.registered); err != nil {
			return err
		}
	}
	// 即使是修复上次只落过盘的单元，也先让用户管理器重新读取单元内容。
	if _, err := b.call(ctx, "daemon-reload"); err != nil {
		return err
	}
	if !m.enabled {
		if _, err := b.call(ctx, "enable", linuxUnit(s)); err != nil {
			return err
		}
	}
	if !m.running {
		if _, err := b.call(ctx, "reset-failed", linuxUnit(s)); err != nil {
			return err
		}
		_, err := b.call(ctx, "start", linuxUnit(s))
		return err
	}
	return nil
}

func (b linuxAutostart) remove(ctx context.Context, s autostartSpec, m autostartManagerState) error {
	if m.foreign || m.repair != nil {
		return autoManagerFailure(m.repair)
	}
	if !m.registered {
		return nil
	}
	if _, err := b.call(ctx, "disable", "--now", linuxUnit(s)); err != nil {
		return err
	}
	if err := os.Remove(b.path(s)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, err := b.call(ctx, "daemon-reload")
	return err
}

func (b linuxAutostart) quiesce(ctx context.Context, s autostartSpec) error {
	_, err := b.call(ctx, "stop", linuxUnit(s))
	return err
}

func (b linuxAutostart) linger(ctx context.Context) error {
	_, err := b.run(ctx, loginctlAutostart, "--no-ask-password", "enable-linger", b.uid)
	return err
}

func (b linuxAutostart) enqueue(ctx context.Context, s autostartSpec, revision int64) error {
	args := []string{"--user", "--collect", "--no-ask-password",
		"--unit=" + autoWorkerID(s, revision), "--property=Type=exec", "--property=RuntimeMaxSec=4min",
		"--property=WorkingDirectory=" + strings.ReplaceAll(s.Root, "%", "%%"), "--", s.Executable}
	_, err := b.run(ctx, "/usr/bin/systemd-run", append(args, autoWorkerArgs(s, revision)...)...)
	return err
}

func (linuxAutostart) cleanupWorker(context.Context, autostartSpec, int64) {}
