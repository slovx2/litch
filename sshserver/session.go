// Copyright (c) 2026 tyrs-hand contributors. SPDX-License-Identifier: MIT
package sshserver

import (
	"bufio"
	"context"
	"errors"
	"github.com/pkg/sftp"
	"github.com/slovx2/litch/internal/hostplatform"
	"go.uber.org/zap"
	"golang.org/x/crypto/ssh"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func (s *SSHServer) serveSFTP(channel ssh.Channel) {
	server, err := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(s.options.Home), sftp.WindowsRootEnumeratesDrives())
	if err != nil {
		s.writeExit(channel, 1)
		return
	}
	err = server.Serve()
	_ = server.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		s.writeExit(channel, 1)
		return
	}
	s.writeExit(channel, 0)
}

func (s *SSHServer) runCommand(ctx context.Context, channel ssh.Channel, state *sshSessionState, command string) {
	trimmed := strings.TrimSpace(command)
	if s.options.Command != nil {
		if handled, status := s.options.Command(ctx, trimmed, channel); handled {
			s.writeExit(channel, status)
			return
		}
	}
	handshake, desktopProxy, err := parseDesktopProxyCommand(trimmed)
	if err != nil {
		s.options.Logger.Warn("拒绝无法识别的 Codex Desktop SSH 命令", zap.Error(err))
		s.writeExit(channel, 127)
		return
	}
	if desktopProxy {
		if len(handshake) > 0 {
			if _, err := channel.Write(handshake); err != nil {
				s.writeExit(channel, 1)
				return
			}
		}
		err = s.serveDesktop(channel)
		if err != nil {
			s.options.Logger.Warn("Codex Desktop SSH 会话停止", zap.Error(err))
			s.writeExit(channel, 1)
			return
		}
		s.writeExit(channel, 0)
		return
	}

	s.runProcess(ctx, channel, state, command, channel)
}

func (s *SSHServer) runShell(ctx context.Context, channel ssh.Channel, state *sshSessionState) {
	if state.term != "" {
		s.runProcess(ctx, channel, state, "", channel)
		return
	}
	reader := bufio.NewReaderSize(channel, 64*1024)
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		s.writeExit(channel, 1)
		return
	}
	handshake, desktopProxy, parseErr := parseDesktopProxyCommand(strings.TrimSpace(line))
	if parseErr != nil {
		s.options.Logger.Warn("拒绝无法识别的 Codex Desktop SSH shell 命令", zap.Error(parseErr))
		s.writeExit(channel, 127)
		return
	}
	if desktopProxy {
		if len(handshake) > 0 {
			if _, err := channel.Write(handshake); err != nil {
				s.writeExit(channel, 1)
				return
			}
		}
		if err := s.serveDesktopInput(channel, reader); err != nil {
			s.options.Logger.Warn("Codex Desktop SSH shell 会话停止", zap.Error(err))
			s.writeExit(channel, 1)
			return
		}
		s.writeExit(channel, 0)
		return
	}
	s.runProcess(ctx, channel, state, "", io.MultiReader(strings.NewReader(line), reader))
}

func (s *SSHServer) runProcess(ctx context.Context, channel ssh.Channel, state *sshSessionState, command string, input io.Reader) {
	arguments := []string(nil)
	if strings.TrimSpace(command) != "" {
		if s.options.EntryBin != "" {
			prefix := shellQuote(s.options.EntryBin)
			if runtime.GOOS == "windows" {
				prefix = "\"$(cygpath -u " + shellQuote(s.options.EntryBin) + ")\""
			}
			command = "export PATH=" + prefix + ":\"$PATH\"; " + command
		}
		arguments = []string{"-lc", command}
	}
	process := exec.CommandContext(ctx, s.options.Shell, arguments...)
	if state.term == "" {
		hostplatform.Prepare(process)
	}
	process.Cancel = func() error { return hostplatform.Kill(process) }
	process.Dir = s.options.Home
	// 与 OpenSSH 一致由服务端导出登录 shell；Claude 入口的基础环境不继承宿主变量，
	// 缺少 SHELL 时 Codex Desktop 远程启动器会直接拒绝连接。
	values := map[string]string{"HOME": s.options.Home, "CODEX_HOME": s.options.CodexHome, "SHELL": s.options.Shell}
	for name, value := range state.environment {
		if allowedSSHEnvironment(name) {
			values[name] = value
		}
	}
	if state.term != "" {
		values["TERM"] = state.term
	}
	environment := os.Environ()
	if s.options.Environment != nil {
		environment = s.options.Environment()
	}
	if s.options.EntryBin != "" {
		values["PATH"] = s.options.EntryBin + string(os.PathListSeparator) + environmentValue(environment, "PATH")
		values["CODEX_INSTALL_DIR"] = s.options.EntryBin
	}
	process.Env = replaceEnvironment(environment, values)
	if state.term != "" {
		s.runPTY(ctx, channel, state, process)
		return
	}
	process.Stdout, process.Stderr = channel, channel.Stderr()
	stdin, err := process.StdinPipe()
	if err != nil {
		s.writeExit(channel, 1)
		return
	}
	if err = process.Start(); err != nil {
		_ = stdin.Close()
		s.writeExit(channel, exitStatus(err))
		return
	}
	cleanup, err := hostplatform.Track(process)
	if err != nil {
		_ = hostplatform.Kill(process)
		_ = process.Wait()
		s.writeExit(channel, 1)
		return
	}
	defer cleanup()
	// 不让 exec.Wait 等待客户端输入 EOF。proxy 已退出时必须立即结束 SSH
	// 会话，随后 channel.Close 会释放仍在等待客户端输入的转发协程。
	go func() { _, _ = io.Copy(stdin, input); _ = stdin.Close() }()
	err = process.Wait()
	_ = stdin.Close()
	s.writeExit(channel, exitStatus(err))
}
