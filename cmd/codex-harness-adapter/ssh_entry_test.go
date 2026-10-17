package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

func waitUntil(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("等待超时: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 假运行时一接上就发一句话再断开，读得到说明运行时真的在工作。
func runtimeAnswers(entry configuration) bool {
	connection, err := hostplatform.Dial(entry.socket())
	if err != nil {
		return false
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	data, _ := io.ReadAll(connection)
	return string(data) == "runtime-proxy"
}

func readSSHEntryStatus(entry configuration) sshEntryStatus {
	var status sshEntryStatus
	if data, err := os.ReadFile(sshEntryStatusPath(entry)); err == nil {
		_ = json.Unmarshal(data, &status)
	}
	return status
}

func sshPortOpen(port int) bool {
	connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

func stopStarted(t *testing.T, cancel context.CancelFunc, done <-chan error) {
	t.Helper()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("停止超时")
	}
}

func TestSSHOptionParsing(t *testing.T) {
	for args, disabled := range map[string]bool{"": false, "--ssh=on": false, "--ssh=off": true} {
		cfg, err := parseConfiguration(append([]string{"--home", t.TempDir()}, strings.Fields(args)...))
		if err != nil || cfg.sshDisabled != disabled {
			t.Fatalf("%q 解析错误: %+v %v", args, cfg.sshDisabled, err)
		}
	}
	if _, err := parseConfiguration([]string{"--home", t.TempDir(), "--ssh=maybe"}); err == nil {
		t.Fatal("接受了无效的 --ssh 取值")
	}
}

// 端口被占只是这个入口连不上：运行时照常工作，原因记下来并告警；端口空出来之后入口自己接上。
func TestSSHListenFailureKeepsRuntime(t *testing.T) {
	cfg := testConfiguration(t)
	cfg.harness = ""
	cfg.setPort("claude-code", cfg.port)
	cfg.setPort("pi", otherPort(t, cfg.port))
	entries := cfg.entries()
	for _, entry := range entries {
		writeStartFixture(t, entry)
	}
	blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.portOf("claude-code")))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	// 整个过程都在捕获里跑完：后台的 start 一直在写终端，不能半路把终端换回去。
	output, _ := captureTerminal(t, func() error {
		go func() { done <- start(ctx, cfg) }()
		waitStartedHarness(t, entries[1], done)
		waitUntil(t, "记下监听失败的原因", func() bool { return readSSHEntryStatus(entries[0]).State == "failed" })
		status := readSSHEntryStatus(entries[0])
		if status.Reason != "port-unavailable" || status.Port != cfg.portOf("claude-code") || status.Detail == "" {
			t.Fatalf("没有如实记下原因: %+v", status)
		}
		// 多等几轮重试，运行时一直在，状态锁也一直由它拿着。
		time.Sleep(200 * time.Millisecond)
		if !runtimeAnswers(entries[0]) {
			t.Fatal("SSH 监听失败连累了运行时")
		}
		lock, err := os.OpenFile(filepath.Join(entries[0].directory(), "serve.lock"), os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if hostplatform.Lock(lock) == nil {
			t.Fatal("监听失败的入口放掉了状态锁")
		}
		_ = lock.Close()
		select {
		case err := <-done:
			t.Fatalf("服务提前退出: %v", err)
		default:
		}
		_ = blocker.Close()
		waitStartedHarness(t, entries[0], done)
		if status := readSSHEntryStatus(entries[0]); status.State != "listening" {
			t.Fatalf("入口接上后状况没有更新: %+v", status)
		}
		stopStarted(t, cancel, done)
		return nil
	})
	if !strings.Contains(output, "警告：[claude-code] SSH 端口") || !strings.Contains(output, "引擎照常运行") {
		t.Fatalf("没有给出告警: %s", output)
	}
	assertCleanTerminal(t, output)
	for _, entry := range entries {
		if _, err := os.Stat(sshEntryStatusPath(entry)); !os.IsNotExist(err) {
			t.Fatal("退出后入口状况没有清掉")
		}
		if sshPortOpen(entry.port) {
			t.Fatal("退出后 SSH 仍在监听")
		}
	}
}

// --ssh=off：不起内置 SSH 服务、不占端口，也不生成 SSH 用的密钥；运行时照常。
func TestSSHOffStartsNoSSHServer(t *testing.T) {
	cfg := testConfiguration(t)
	cfg.harness = ""
	cfg.setPort("claude-code", cfg.port)
	cfg.setPort("pi", otherPort(t, cfg.port))
	cfg.sshDisabled = true
	entries := cfg.entries()
	for _, entry := range entries {
		writeStartFixture(t, entry)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	output, _ := captureTerminal(t, func() error {
		go func() { done <- start(ctx, cfg) }()
		for _, entry := range entries {
			waitUntil(t, entry.harness+" 报告入口已关闭", func() bool { return readSSHEntryStatus(entry).State == "off" })
		}
		for _, entry := range entries {
			if !entry.sshDisabled {
				t.Fatal("入口没有继承 --ssh=off")
			}
			if !runtimeAnswers(entry) {
				t.Fatalf("%s 运行时没有工作", entry.harness)
			}
			if sshPortOpen(entry.port) {
				t.Fatalf("%s 仍然监听了 SSH 端口", entry.harness)
			}
			for _, name := range []string{"identity", "host_key", "known_hosts", "entry-bin"} {
				if _, err := os.Stat(filepath.Join(entry.directory(), name)); !os.IsNotExist(err) {
					t.Fatalf("关闭 SSH 时不该准备 %s", name)
				}
			}
		}
		select {
		case err := <-done:
			t.Fatalf("服务提前退出: %v", err)
		default:
		}
		stopStarted(t, cancel, done)
		return nil
	})
	if strings.Contains(output, "SSH 就绪") || strings.Contains(output, "Host codex-harness-adapter") || !strings.Contains(output, "SSH 入口已关闭") {
		t.Fatalf("关闭 SSH 时的输出不对: %s", output)
	}
	for _, entry := range entries {
		if connection, err := hostplatform.Dial(entry.socket()); err == nil {
			_ = connection.Close()
			t.Fatal("退出后运行时仍在监听")
		}
	}
}

// 没做过 init 的 serve：SSH 入口起不来只告警，运行时不跟着停。
func TestSSHSetupFailureKeepsRuntime(t *testing.T) {
	cfg := testConfiguration(t)
	writeStartFixture(t, cfg)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	output, _ := captureTerminal(t, func() error {
		go func() { done <- serve(ctx, cfg) }()
		waitUntil(t, "记下准备失败的原因", func() bool { return readSSHEntryStatus(cfg).State == "failed" })
		if status := readSSHEntryStatus(cfg); status.Reason != "setup-failed" {
			t.Fatalf("原因分类不对: %+v", status)
		}
		if !runtimeAnswers(cfg) || sshPortOpen(cfg.port) {
			t.Fatal("准备失败后运行时应在、SSH 不应监听")
		}
		stopStarted(t, cancel, done)
		return nil
	})
	if !strings.Contains(output, "SSH 入口没有启动") || !strings.Contains(output, "init") {
		t.Fatalf("告警里没有可操作的提示: %s", output)
	}
}
