package sshtransport

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/logtail"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func TestPairingTailHosts(t *testing.T) {
	peer := &ipnstate.PeerStatus{
		HostName: "Build", DNSName: "build.example.ts.net.",
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.100.10.20"), netip.MustParseAddr("fd7a:115c:a1e0::1")},
	}
	status := &ipnstate.Status{Self: peer, Peer: map[key.NodePublic]*ipnstate.PeerStatus{
		key.NewNode().Public(): peer,
		key.NewNode().Public(): nil,
		key.NewNode().Public(): {HostName: "no-address"},
	}}
	got := tailHosts(status)
	want := []string{"build", "build.example.ts.net", "100.100.10.20", "fd7a:115c:a1e0::1"}
	if !slices.Equal(got, want) {
		t.Fatalf("节点表提示地址不符：%v", got)
	}
	if got := tailHosts(&ipnstate.Status{}); len(got) != 0 {
		t.Fatalf("空节点表应无候选：%v", got)
	}
}

type testTailStorage struct {
	mu     sync.Mutex
	text   string
	failed bool
}

type tailLogBuffer struct{ writes atomic.Int32 }

func (b *tailLogBuffer) Write(p []byte) (int, error) { b.writes.Add(1); return len(p), nil }
func (*tailLogBuffer) TryReadLine() ([]byte, error)  { return nil, nil }

func (s *testTailStorage) Read() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.text, nil
}
func (s *testTailStorage) Write(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed {
		return errors.New("locked")
	}
	s.text = text
	return nil
}
func (s *testTailStorage) Clear() error { s.mu.Lock(); defer s.mu.Unlock(); s.text = ""; return nil }

func TestTailStoreAtomicFailureAndRestart(t *testing.T) {
	native := &testTailStorage{}
	s, err := newTailStore(native)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.setControl(defaultTailControl); err != nil {
		t.Fatal(err)
	}
	input := []byte("private-node-key")
	if err := s.WriteState("node", input); err != nil {
		t.Fatal(err)
	}
	input[0] = 'X'
	read, _ := s.ReadState("node")
	read[0] = 'Y'
	native.failed = true
	if err := s.WriteState("node", []byte("replacement")); err == nil {
		t.Fatal("write failure ignored")
	}
	value, _ := s.ReadState("node")
	if string(value) != "private-node-key" {
		t.Fatal("failed write or caller mutated state")
	}
	native.failed = false
	reopened, err := newTailStore(native)
	if err != nil {
		t.Fatal(err)
	}
	if !reopened.enabled() || reopened.control() != defaultTailControl {
		t.Fatal("lost config")
	}
	if err := reopened.setControl("https://headscale.example"); err == nil {
		t.Fatal("reused identity with another server")
	}
	if err := reopened.disable(); err != nil {
		t.Fatal(err)
	}
	reopened, err = newTailStore(native)
	if err != nil || reopened.enabled() {
		t.Fatal("logout not persisted", err)
	}
	if err := reopened.WriteState("node", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.ReadState("node"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatal(err)
	}
	native.text = "{}"
	if _, err := newTailStore(native); err == nil {
		t.Fatal("corrupt state accepted")
	}
}

func TestTailControlHTTPSOnly(t *testing.T) {
	for _, input := range []string{"http://host", "https://u:p@host", "https://host?key=x", "https://host#x", "host", "https:///"} {
		if _, err := tailControl(input); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
	if got, err := tailControl(" https://headscale.example/ "); err != nil || got != "https://headscale.example" {
		t.Fatal(got, err)
	}
}

func TestTailStateErrorsDistinguishApprovalAndStartup(t *testing.T) {
	for _, state := range []string{"Starting", "NoState", "Running"} {
		if err := tailStateError(state); err != nil {
			t.Fatal("启动过程不能误报未登录", state, err)
		}
	}
	if err := tailStateError("NeedsMachineAuth"); err == nil || !strings.Contains(err.Error(), "[tailscaleApproval]") {
		t.Fatal("审批原因丢失", err)
	}
	if err := tailStateError("NeedsLogin"); err == nil || !strings.Contains(err.Error(), "[tailscaleLogin]") {
		t.Fatal("登录原因丢失", err)
	}
}

func TestSystemTailHandshakeFailureSuggestsEmbeddedLogin(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	err := errors.New("SSH handshake timed out")
	wrapped := &systemTailConnection{Conn: left}
	if !strings.Contains(systemTailFailure(wrapped, kindUnreachable, err).Error(), "[tailscaleAutoLogin]") {
		t.Fatal("系统 VPN 接受 TCP 但握手超时，漏了登录提示")
	}
	for _, kind := range []string{kindAuth, kindHostKeyChanged, kindVerify} {
		if systemTailFailure(wrapped, kind, err) != err {
			t.Fatal("不应掩盖 SSH 认证或指纹错误", kind)
		}
	}
	if systemTailFailure(left, kindUnreachable, err) != err {
		t.Fatal("普通系统连接不应提示 Tailscale")
	}
}

func TestTailnetAddressNeverResolvesPublicHost(t *testing.T) {
	s := &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
		key.NewNode().Public(): {DNSName: "work.tail.ts.net.", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.1.2")}},
	}}
	for _, host := range []string{"work", "WORK.tail.ts.net.", "100.64.1.2"} {
		got, err := tailAddress(host, 2222, s)
		if err != nil || got != "100.64.1.2:2222" {
			t.Fatal(host, got, err)
		}
	}
	for _, host := range []string{"localhost", "example.com", "127.0.0.1", "100.1.1.1", "::1", "192.168.0.1"} {
		if _, err := tailAddress(host, 22, s); err == nil {
			t.Fatal("escaped tailnet", host)
		}
	}
}

func TestAutoRouteUsesAuthenticatedPeerMap(t *testing.T) {
	s := &ipnstate.Status{BackendState: "Running", Peer: map[key.NodePublic]*ipnstate.PeerStatus{
		key.NewNode().Public(): {HostName: "work", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.1.2")}},
	}}
	for _, host := range []string{"work", "100.64.0.1", "100.127.255.255", "fd7a:115c:a1e0::1", "work.tail.ts.net"} {
		if !routeInTailnet(host, 22, s) {
			t.Fatal("已登录节点未选内嵌", host)
		}
	}
	for _, host := range []string{"100.63.1.1", "100.128.1.1", "unknown", "example.com"} {
		if routeInTailnet(host, 22, s) {
			t.Fatal("无关地址误选内嵌", host)
		}
	}
	s.BackendState = "NeedsLogin"
	if routeInTailnet("work", 22, s) || routeInTailnet("100.64.1.2", 22, s) {
		t.Fatal("未登录时不能抢系统网络")
	}
}

func TestTailDialRequiresLoginAndDirectStillWorks(t *testing.T) {
	// 未登录、已暂停、清除状态均不能回退到本地监听端口。
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	if err := TailscaleInitialize(t.TempDir(), "litch-test", &testTailStorage{}); err != nil {
		t.Fatal(err)
	}
	TailscaleNetworkChanged("offline-test", false)
	if tailNode.server != nil {
		t.Fatal("网络通知不应自动注册节点")
	}
	buffer := &tailLogBuffer{}
	log := logtail.NewLogger(logtail.Config{Collection: "test", BaseURL: "http://127.0.0.1:9", Buffer: buffer, Stderr: io.Discard}, logger.Discard)
	_, _ = log.Write([]byte("test authentication URL must not be buffered"))
	_ = log.Shutdown(context.Background())
	if buffer.writes.Load() != 0 {
		t.Fatal("初始化没有禁用 tsnet 自建日志器")
	}
	t.Cleanup(func() {
		_ = TailscaleStop()
		tailNode.Lock()
		tailNode.storage = nil
		tailNode.store = nil
		tailNode.paused = false
		tailNode.Unlock()
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := dialSSH(ctx, "127.0.0.1", port, "always"); err == nil || !strings.Contains(err.Error(), "[tailscaleLogin]") {
		t.Fatal(err)
	}
	direct, err := dialSSH(ctx, "127.0.0.1", port, "never")
	if err != nil {
		t.Fatal(err)
	}
	_ = direct.Close()
	auto, err := dialSSH(ctx, "127.0.0.1", port, "auto")
	if err != nil {
		t.Fatal("未登录自动模式应保留系统连接", err)
	}
	_ = auto.Close()
	if ConnectionRoute("127.0.0.1", port, "auto") != "system" {
		t.Fatal("系统路由记录丢失")
	}
	pauseTailscale(true)
	if _, err := dialSSH(ctx, "127.0.0.1", port, "always"); err == nil || !strings.Contains(err.Error(), "[tailscalePaused]") {
		t.Fatal(err)
	}
	pauseTailscale(false)
	if err := TailscaleClear(); err != nil {
		t.Fatal(err)
	}
	if _, err := ProbeHost("127.0.0.1", port, "user", "always"); err == nil || !strings.Contains(err.Error(), "[tailscaleLogin]") {
		t.Fatal(err)
	}
}
