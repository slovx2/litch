package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
	"golang.org/x/crypto/ssh"
)

func TestStartOptions(t *testing.T) {
	for _, args := range [][]string{{"--port", "7333"}, {"--pi-port", "7331"}, {"--claude-port", "-1"}, {"--dsh-port", "7331"}, {"--dsh-port", "0"}} {
		if _, err := parseConfiguration(args); err == nil {
			t.Fatalf("接受歧义或冲突端口: %v", args)
		}
	}
	cfg, err := parseConfiguration([]string{"--claude-port", "7441", "--pi-port", "7442"})
	if err != nil {
		t.Fatal(err)
	}
	entries := cfg.entries()
	if len(entries) != 2 || entries[0].harness != "claude-code" || entries[0].port != 7441 || entries[1].harness != "pi" || entries[1].port != 7442 {
		t.Fatalf("入口配置错误: %+v", entries)
	}
	cfg, err = parseConfiguration([]string{"--harness", "pi", "--port", "7443"})
	if err != nil || len(cfg.entries()) != 1 || cfg.entries()[0].port != 7443 {
		t.Fatalf("单引擎端口错误: %+v %v", cfg, err)
	}
	// 单独启动 dsh 时默认端口与另外两个入口错开。
	cfg, err = parseConfiguration([]string{"--harness", "dsh"})
	if err != nil || len(cfg.entries()) != 1 || cfg.entries()[0].port != 7333 ||
		!strings.HasSuffix(cfg.adapter(), filepath.Join("packages", "dsh", "dist", "dsh", "src", "adapter.mjs")) {
		t.Fatalf("dsh 入口配置错误: %+v %v", cfg, err)
	}
}

func TestSuperviseFailureKeepsSiblingRunning(t *testing.T) {
	entered, failed, cleaned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	expected := errors.New("端口冲突")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- supervise(ctx, []configuration{{harness: "claude-code"}, {harness: "pi"}}, func(ctx context.Context, c configuration) error {
			if c.harness == "pi" {
				<-entered
				close(failed)
				return expected
			}
			close(entered)
			<-ctx.Done()
			close(cleaned)
			return ctx.Err()
		})
	}()
	<-failed
	select {
	case <-cleaned:
		t.Fatal("一个入口失败停止了其他入口")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("中断后未等待清理完成")
	}
	<-cleaned
}

func TestSuperviseAllUnavailableFails(t *testing.T) {
	missing := errors.New("没有安装 CLI")
	err := supervise(t.Context(), []configuration{{harness: "claude-code"}, {harness: "pi"}}, func(context.Context, configuration) error { return missing })
	if !errors.Is(err, missing) || !strings.Contains(err.Error(), "没有可用") {
		t.Fatalf("全部不可用时没有报错: %v", err)
	}
}

func TestSSHConfigSkipsUnavailableHarness(t *testing.T) {
	cfg := testConfiguration(t)
	cfg.harness = "pi"
	if err := initialize(cfg); err != nil {
		t.Fatal(err)
	}
	args := []string{"ssh-config", "--home", cfg.home, "--pi-port", fmt.Sprint(cfg.port)}
	if err := run(t.Context(), args); err != nil {
		t.Fatalf("缺失 Claude 阻止输出 Pi 配置: %v", err)
	}
	if err := run(t.Context(), append(args, "--harness", "claude-code")); err == nil {
		t.Fatal("显式选择未初始化入口应报错")
	}
}

func TestStartAllInitializesAndStopsBothHarnesses(t *testing.T) {
	cfg := testConfiguration(t)
	cfg.harness = ""
	cfg.setPort("claude-code", cfg.port)
	cfg.setPort("pi", otherPort(t, cfg.port))
	for _, entry := range cfg.entries() {
		writeStartFixture(t, entry)
	}
	// 连续启动两次，验证自动初始化保留身份、Ctrl-C 清理后可再次启动。
	identities := map[string]string{}
	for attempt := 0; attempt < 2; attempt++ {
		if attempt == 1 {
			// 换端口后专用 known_hosts 必须同步更新，且身份保持不变。
			claude, pi := cfg.portOf("claude-code"), cfg.portOf("pi")
			cfg.setPort("claude-code", pi)
			cfg.setPort("pi", claude)
		}
		ctx, cancel := context.WithCancel(t.Context())
		t.Cleanup(cancel)
		done := make(chan error, 1)
		go func() { done <- start(ctx, cfg) }()
		for _, entry := range cfg.entries() {
			waitStartedHarness(t, entry, done)
			key, err := os.ReadFile(filepath.Join(entry.directory(), "identity"))
			if err != nil {
				t.Fatal(err)
			}
			if attempt == 1 && identities[entry.harness] != string(key) {
				t.Fatal("再次启动覆盖身份")
			}
			identities[entry.harness] = string(key)
			known, err := os.ReadFile(filepath.Join(entry.directory(), "known_hosts"))
			if err != nil || !strings.HasPrefix(string(known), fmt.Sprintf("[127.0.0.1]:%d ", entry.port)) {
				t.Fatalf("known_hosts 端口未同步: %s %v", known, err)
			}
		}
		if identities["claude-code"] == identities["pi"] {
			t.Fatal("两入口身份未隔离")
		}
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("双入口退出超时")
		}
		for _, entry := range cfg.entries() {
			if connection, err := hostplatform.Dial(entry.socket()); err == nil {
				_ = connection.Close()
				t.Fatal("退出后运行时仍在监听")
			}
			if connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", entry.port), time.Second); err == nil {
				_ = connection.Close()
				t.Fatal("退出后 SSH 仍在监听")
			}
		}
	}
}

func writeStartFixture(t *testing.T, entry configuration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(entry.adapter()), 0o700); err != nil {
		t.Fatal(err)
	}
	fixture := fmt.Sprintf(`import net from 'node:net';
if (process.argv.includes('--runtime-info')) console.log(JSON.stringify({engine:%q,protocolVersion:'0.163.0',nodeVersion:process.versions.node}));
else { net.createServer(c=>{c.on('error',()=>{});c.end('runtime-proxy')}).listen(process.argv.at(-1).slice(7)); }
`, entry.harness)
	if err := os.WriteFile(entry.adapter(), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestUnavailableHarnessDoesNotStopWorkingSSH(t *testing.T) {
	cfg := testConfiguration(t)
	cfg.harness = ""
	cfg.setPort("claude-code", cfg.port)
	cfg.setPort("pi", otherPort(t, cfg.port))
	entries := cfg.entries()
	for _, entry := range entries {
		writeStartFixture(t, entry)
	}
	if err := os.WriteFile(entries[0].adapter(), []byte("console.error('Claude CLI 未安装'); process.exit(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	waitStartedHarness(t, entries[1], done)
	// 等待失败入口释放状态锁，确保测到失败处理之后的存活状态。
	deadline := time.Now().Add(10 * time.Second)
	for {
		file, err := os.OpenFile(filepath.Join(entries[0].directory(), "serve.lock"), os.O_RDWR, 0o600)
		if err == nil {
			err = hostplatform.Lock(file)
			if err == nil {
				hostplatform.Unlock(file)
			}
			_ = file.Close()
			if err == nil {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("失败入口未清理")
		}
		time.Sleep(25 * time.Millisecond)
	}
	waitStartedHarness(t, entries[1], done)
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

func waitStartedHarness(t *testing.T, entry configuration, done <-chan error) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("服务提前退出: %v", err)
		default:
		}
		identity, err := readIdentity(filepath.Join(entry.directory(), "identity"))
		host, hostErr := readIdentity(filepath.Join(entry.directory(), "host_key"))
		if err == nil && hostErr == nil {
			client, err := ssh.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", entry.port), &ssh.ClientConfig{
				User: "local", Auth: []ssh.AuthMethod{ssh.PublicKeys(identity)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second,
			})
			last = err
			if err == nil {
				session, err := client.NewSession()
				if err != nil {
					_ = client.Close()
					t.Fatal(err)
				}
				output, err := session.Output("codex --version")
				_ = session.Close()
				_ = client.Close()
				if err != nil || !strings.Contains(string(output), "codex-harness-adapter-"+entry.harness) {
					t.Fatalf("入口身份错误: %s %v", output, err)
				}
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("%s 启动超时: %v", entry.harness, last)
}
