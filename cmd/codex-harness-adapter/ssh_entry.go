package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
	"github.com/slovx2/litch/sshserver"
	"golang.org/x/crypto/ssh"
)

// 内置的 SSH 入口是给官方 Codex 桌面端连的，对运行时来说是可选件：
// 准备（身份、主机密钥、入口脚本）和监听都在运行时起来之后做，任何一步失败都只是这个入口不可用，
// 记下原因、给出告警，运行时和聚合面照常工作。端口被占时隔一阵重试，空出来就接上，不用重启服务。
var (
	sshRetryDelay = 2 * time.Second
	sshRetryLimit = 30 * time.Second
)

// 入口当前的状况写在 <home>/<harness>/ssh-entry.json，运行时停下时删掉。
// 常驻服务把它读出来，经控制通道交给设备进程，客户端在设置里看到的就是它。
type sshEntryStatus struct {
	State     string `json:"state"` // off、listening、failed
	Port      int    `json:"port"`
	Reason    string `json:"reason,omitempty"` // port-unavailable、setup-failed、start-failed
	Detail    string `json:"detail,omitempty"`
	UpdatedAt string `json:"updatedAt"`
}

func sshEntryStatusPath(c configuration) string {
	return filepath.Join(c.directory(), "ssh-entry.json")
}

func writeSSHEntryStatus(c configuration, state, reason string, cause error) {
	status := sshEntryStatus{State: state, Port: c.port, Reason: reason, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	if cause != nil {
		status.Detail = cause.Error()
	}
	_ = writePrivateJSON(sshEntryStatusPath(c), status)
	if c.statusChanged != nil {
		c.statusChanged()
	}
}

func loadSSHEntryStatus(c configuration) (sshEntryStatus, bool) {
	var status sshEntryStatus
	data, err := os.ReadFile(sshEntryStatusPath(c))
	if err != nil || json.Unmarshal(data, &status) != nil {
		return status, false
	}
	return status, true
}

// runSSHEntry 在运行时起来之后管着它的 SSH 入口：照现行的设置开着或者关着，设置变了就跟着变。
// 返回的函数停掉入口并等它收完。
func runSSHEntry(ctx context.Context, c configuration, version string, autoInit bool, runtimeDone <-chan struct{}, log io.Writer, hooks *runtimeHooks) func() {
	loopContext, cancel := context.WithCancel(ctx)
	stopped := make(chan struct{})
	current := func() (bool, int) {
		if hooks == nil {
			return !c.sshDisabled, c.port
		}
		return hooks.ssh()
	}
	var wake <-chan struct{}
	if hooks != nil {
		wake = hooks.sshWake
	}
	go func() {
		defer close(stopped)
		defer os.Remove(sshEntryStatusPath(c))
		for loopContext.Err() == nil {
			enabled, port := current()
			entry := c
			entry.sshDisabled, entry.port = !enabled, port
			entryContext, stopEntry := context.WithCancel(loopContext)
			finished := make(chan struct{})
			if enabled {
				go func() {
					defer close(finished)
					serveSSHEntry(entryContext, entry, version, autoInit, runtimeDone, log)
				}()
			} else {
				writeSSHEntryStatus(entry, "off", "", nil)
				fmt.Printf(tr("%s 就绪（SSH 入口已关闭）；按 Ctrl-C 停止\n", "%s ready (SSH entry is off); press Ctrl-C to stop\n"), c.harness)
				close(finished)
			}
			// 别的设置变了也会被叫醒：这个入口的开关或者端口真的变了才动它。
			for changed := false; !changed; {
				select {
				case <-loopContext.Done():
					changed = true
				case <-wake:
					nowEnabled, nowPort := current()
					changed = nowEnabled != enabled || (nowEnabled && nowPort != port)
				}
			}
			stopEntry()
			<-finished
		}
	}()
	return func() { cancel(); <-stopped }
}

// 先写临时文件再改名，读的一方不会读到写了一半的内容。
func writePrivateJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

type sshEntryMaterial struct {
	identity ssh.Signer
	home     string
}

func prepareSSHEntry(c configuration, version string, autoInit bool) (sshEntryMaterial, error) {
	material := sshEntryMaterial{}
	if autoInit {
		if err := initialize(c); err != nil {
			return material, err
		}
	}
	identity, err := readIdentity(filepath.Join(c.directory(), "identity"))
	if err != nil {
		return material, err
	}
	if _, err := os.Stat(filepath.Join(c.directory(), "host_key")); err != nil {
		return material, errors.New(tr("缺少 HostKey，请先运行 init", "the host key is missing; run init first"))
	}
	if err := installEntry(c, version); err != nil {
		return material, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return material, fmt.Errorf(tr("无法读取用户主目录: %w", "cannot read the user's home directory: %w"), err)
	}
	return sshEntryMaterial{identity: identity, home: home}, nil
}

// serveSSHEntry 一直跑到 ctx 结束。它不返回错误：入口出什么问题都不该让运行时停下。
func serveSSHEntry(ctx context.Context, c configuration, version string, autoInit bool, runtimeDone <-chan struct{}, log io.Writer) {
	unaffected := tr("引擎照常运行，其他入口不受影响", "the engine keeps running and other entries are unaffected")
	material, err := prepareSSHEntry(c, version, autoInit)
	if err != nil {
		fmt.Fprintf(log, "\nSSH 入口准备失败: %v\n", err)
		writeSSHEntryStatus(c, "failed", "setup-failed", err)
		fmt.Fprintf(os.Stderr, tr("警告：[%s] SSH 入口没有启动：%v；%s。\n", "Warning: [%s] the SSH entry did not start: %v; %s.\n"), c.harness, err, unaffected)
		return
	}
	shell := hostplatform.DefaultShell()
	warned := false
	for delay := sshRetryDelay; ; delay = min(delay*2, sshRetryLimit) {
		server, err := sshserver.StartSSHServer(ctx, sshserver.SSHOptions{
			ListenAddr: fmt.Sprintf("127.0.0.1:%d", c.port), HostKeyFile: filepath.Join(c.directory(), "host_key"),
			Home: material.home, CodexHome: filepath.Join(c.directory(), "codex"), Shell: shell,
			AuthorizedClients: []sshserver.AuthorizedClient{{ID: "local", PublicKey: material.identity.PublicKey()}},
			Runtime:           localRuntime{socket: c.socket(), sessions: c.desktops}, EntryBin: filepath.Join(c.directory(), "entry-bin"),
			Environment: c.environment,
			Command: func(_ context.Context, command string, channel io.ReadWriteCloser) (bool, uint32) {
				switch strings.TrimSpace(command) {
				case "codex --version", "codex -V":
					_, _ = fmt.Fprintln(channel, "codex-cli "+version)
					return true, 0
				case "codex app-server daemon start":
					select {
					case <-runtimeDone:
						return true, 1
					default:
						return true, 0
					}
				}
				return false, 0
			},
		})
		if err == nil {
			writeSSHEntryStatus(c, "listening", "", nil)
			fmt.Printf(tr("%s SSH 就绪: %s；按 Ctrl-C 停止\n", "%s SSH ready: %s; press Ctrl-C to stop\n"), c.harness, server.Addr())
			if autoInit {
				if err := printSSHConfig(c); err != nil {
					fmt.Fprintf(os.Stderr, tr("警告：[%s] 无法输出 SSH 配置: %v\n", "Warning: [%s] cannot print the SSH config: %v\n"), c.harness, err)
				}
			}
			<-ctx.Done()
			_ = server.Close()
			return
		}
		if ctx.Err() != nil {
			return
		}
		var operation *net.OpError
		if !errors.As(err, &operation) || operation.Op != "listen" {
			fmt.Fprintf(log, "\nSSH 入口启动失败: %v\n", err)
			writeSSHEntryStatus(c, "failed", "start-failed", err)
			fmt.Fprintf(os.Stderr, tr("警告：[%s] SSH 入口启动失败，详见日志 %s；%s。\n", "Warning: [%s] the SSH entry failed to start, see the log %s; %s.\n"),
				c.harness, filepath.Join(c.harnessLogDirectory(), "runtime.log"), unaffected)
			return
		}
		if !warned {
			warned = true
			fmt.Fprintf(log, tr("\nSSH 监听失败: %v\n", "\nSSH failed to listen: %v\n"), err)
			writeSSHEntryStatus(c, "failed", "port-unavailable", err)
			fmt.Fprintf(os.Stderr, tr(
				"警告：[%s] SSH 端口 %d 无法使用，请关闭占用程序或更改此引擎的 SSH 端口；%s，端口空出后会自动接上。\n",
				"Warning: [%s] SSH port %d is unavailable; close the program using it or change this engine's SSH port. %s; the entry comes up by itself once the port is free.\n",
			), c.harness, c.port, unaffected)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}
