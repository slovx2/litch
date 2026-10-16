package main

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func testConfiguration(t *testing.T) configuration {
	t.Helper()
	base := "/tmp"
	if runtime.GOOS == "windows" {
		base = os.TempDir()
	}
	dir, err := os.MkdirTemp(base, "cha-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return configuration{harness: "pi", home: dir, root: dir, node: "node", port: port}
}

// otherPort 再要一个空闲端口，保证和 taken 不是同一个。
// testConfiguration 拿端口的办法是“监听 0 号端口、读出来、关掉”：前一个关了之后，系统可能把同一个端口再发出来。
// Claude 和 Pi 的端口必须不同，撞上了命令行在参数检查那一步就退出，后面要验的东西根本走不到（流水线上挂过一次）。
func otherPort(t *testing.T, taken int) int {
	t.Helper()
	for range 50 {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()
		if port != taken {
			return port
		}
	}
	t.Fatalf("要不到一个和 %d 不同的端口", taken)
	return 0
}

func TestIdentityPreservedAndHarnessIsolated(t *testing.T) {
	cfg := testConfiguration(t)
	if err := initialize(cfg); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cfg.directory(), "identity")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	hostBefore, _ := os.ReadFile(filepath.Join(cfg.directory(), "host_key"))
	if err := initialize(cfg); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	hostAfter, _ := os.ReadFile(filepath.Join(cfg.directory(), "host_key"))
	if string(before) != string(after) || string(hostBefore) != string(hostAfter) {
		t.Fatal("重复初始化覆盖了密钥")
	}
	stat, _ := os.Stat(path)
	if runtime.GOOS != "windows" && stat.Mode().Perm() != 0o600 {
		t.Fatal("私钥权限错误")
	}
	cfg.harness = "claude-code"
	if err := initialize(cfg); err != nil {
		t.Fatal(err)
	}
	other, _ := os.ReadFile(filepath.Join(cfg.directory(), "identity"))
	if string(before) == string(other) {
		t.Fatal("不同 harness 共用身份")
	}
}

func TestOnlyLoopbackOptions(t *testing.T) {
	for _, args := range [][]string{{"--listen", "0.0.0.0"}, {"--port", "65536"}, {"--harness", "unknown"}} {
		if _, err := parseConfiguration(args); err == nil {
			t.Fatalf("接受非法参数: %v", args)
		}
	}
}

func TestForegroundSSHAndCleanup(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatal("测试需要 Node")
	}
	cfg := testConfiguration(t)
	if err := initialize(cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(cfg.adapter()), 0o700); err != nil {
		t.Fatal(err)
	}
	fixture := `import net from 'node:net';
if (process.argv.includes('--runtime-info')) console.log(JSON.stringify({engine:'pi',protocolVersion:'0.157.1',nodeVersion:process.versions.node}));
else { const socket=process.argv.at(-1).slice(7); net.createServer(c=>{c.on('error',()=>{});c.end('runtime-proxy')}).listen(socket); }
`
	if err := os.WriteFile(cfg.adapter(), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg) }()
	identity, err := readIdentity(filepath.Join(cfg.directory(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	host, err := readIdentity(filepath.Join(cfg.directory(), "host_key"))
	if err != nil {
		t.Fatal(err)
	}
	var client *ssh.Client
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		client, err = ssh.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.port)), &ssh.ClientConfig{
			User: "local", Auth: []ssh.AuthMethod{ssh.PublicKeys(identity)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey()), Timeout: time.Second,
		})
		if err == nil {
			break
		}
		select {
		case failure := <-done:
			t.Fatalf("启动失败: %v", failure)
		default:
		}
		time.Sleep(25 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	for command, want := range map[string]string{"codex --version": "codex-cli 0.157.1 (codex-harness-adapter-pi)\n", "codex app-server proxy": "runtime-proxy"} {
		session, err := client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		output, err := session.Output(command)
		_ = session.Close()
		if err != nil || string(output) != want {
			t.Fatalf("%s: %q %v", command, output, err)
		}
	}
	if err := serve(ctx, cfg); err == nil {
		t.Fatal("允许同时占用状态目录")
	}
	if _, err := client.Dial("tcp", "127.0.0.1:80"); err == nil {
		t.Fatal("允许通用转发")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("服务退出超时")
	}
	if _, err := os.Stat(cfg.socket()); !os.IsNotExist(err) {
		t.Fatal("socket 未清理")
	}
	if _, err := os.Stat(filepath.Join(cfg.directory(), "identity")); err != nil {
		t.Fatal("退出删除了身份")
	}
}
