//go:build !windows

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentCommandUsesHostGitBeforeStartingNode(t *testing.T) {
	dir := t.TempDir()
	host := filepath.Join(dir, "host")
	slotDir := filepath.Join(dir, "shims")
	for _, path := range []string{host, slotDir} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	node := filepath.Join(dir, "node")
	alias := filepath.Join(dir, "another-path-to-shims")
	if err := os.Symlink(slotDir, alias); err != nil {
		t.Fatal(err)
	}
	for path, contents := range map[string]string{
		node:                            "#!/bin/sh\nprintf 'node started\\n'\n",
		filepath.Join(host, "git"):      "#!/bin/sh\nprintf 'git:%s\\n' \"$@\"\nexit 42\n",
		filepath.Join(host, "gh"):       "#!/bin/sh\nprintf 'host gh\\n'\n",
		filepath.Join(host, "lark-cli"): "#!/bin/sh\nprintf 'host lark\\n'\n",
		filepath.Join(slotDir, "git"):   "#!/bin/sh\nexit 99\n",
	} {
		if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{
		"HOME=" + dir, "PATH=" + slotDir + ":" + alias + ":" + host, "PI_SESSION_ID=test",
		"LITCH_DEVICE_GITHUB_HARNESS=pi", "LITCH_DEVICE_SOCKET=" + filepath.Join(dir, "device.sock"),
	}
	run := func(mode string, argv ...string) cliResult {
		return runCLI(t, "", env, append([]string{"agent-command", slotDir, node, node, mode}, argv...)...)
	}
	var held []*os.File
	for range agentCommandSlots {
		slot, err := acquireAgentCommandSlot(slotDir)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = slot.Close() })
		held = append(held, slot)
	}
	got := run("git", "-c", "protocol.file.allow=user", "-c", "log.showSignature=false",
		"-C", "directory with spaces", "rev-parse", "--is-inside-work-tree")
	if got.code != 42 || !strings.Contains(got.stdout, "git:directory with spaces\ngit:rev-parse\ngit:--is-inside-work-tree\n") {
		t.Fatalf("普通 Git 命令未直达宿主: %+v", got)
	}
	if got := run("git", "fetch"); got.code != 75 || got.stdout != "" {
		t.Fatalf("并发满时仍启动了凭据入口: %+v", got)
	}
	if got := run("git", "remote", "-v", "update"); got.code != 75 {
		t.Fatalf("可联网的 Git remote 子命令绕过了凭据入口: %+v", got)
	}
	// 有 GitHub 上下文时 gh --version 也要问设备，不能直接报宿主 gh 的版本。
	if got := run("gh", "--version"); got.code != 75 || got.stdout != "" {
		t.Fatalf("gh --version 绕过了凭据入口: %+v", got)
	}
	// lark-cli 同样要问设备（经理绑了飞书应用时用设备的代理），没有会话上下文的直达宿主。
	if got := run("lark-cli", "--version"); got.code != 75 || got.stdout != "" {
		t.Fatalf("lark-cli 绕过了设备入口: %+v", got)
	}
	plain := runCLI(t, "", []string{"HOME=" + dir, "PATH=" + slotDir + ":" + host, "LITCH_DEVICE_GITHUB_HARNESS="},
		"agent-command", slotDir, node, node, "lark-cli", "--version")
	if plain.code != 0 || plain.stdout != "host lark\n" {
		t.Fatalf("没有会话上下文的 lark-cli 未直达宿主: %+v", plain)
	}
	_ = held[0].Close()
	if got := run("git", "fetch"); got.code != 0 || got.stdout != "node started\n" {
		t.Fatalf("归还席位后未恢复凭据入口: %+v", got)
	}
}

func TestRuntimeProbeDoesNotStartWhenSlotsFull(t *testing.T) {
	for range runtimeProbeConcurrency {
		runtimeProbeSlots <- struct{}{}
	}
	defer func() {
		for range runtimeProbeConcurrency {
			<-runtimeProbeSlots
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
	defer cancel()
	marker := filepath.Join(t.TempDir(), "started")
	command := exec.CommandContext(ctx, "/bin/sh", "-c", `echo began > "$1"`, "sh", marker)
	if err := runRuntimeProbe(ctx, command); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("等待席位没有按总时限结束: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("已满时启动了子进程: %v", err)
	}
}

func TestRuntimeProbeKillsChildProcessGroup(t *testing.T) {
	started := filepath.Join(t.TempDir(), "started")
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	command := exec.CommandContext(ctx, "/bin/sh", "-c",
		`(trap '' TERM; touch "$1"; exec sleep 30) & wait`, "sh", started)
	command.Stdout = write
	done := make(chan error, 1)
	go func() { done <- runRuntimeProbe(ctx, command) }()
	until := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(until) {
			t.Fatal("探测子进程未启动")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// 用管道观察孙进程持有的文件描述符；整个进程组退出，管道才能立即关闭。
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("取消没有终止探测")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("探测子进程没有按时终止")
	}
	_ = write.Close()
	if err := read.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := read.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("子进程还持有输出管道: %v", err)
	}
}
