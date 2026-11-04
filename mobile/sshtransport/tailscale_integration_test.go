package sshtransport

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"tailscale.com/envknob"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// 真正的 tsnet + WireGuard/netstack + 原有 Go SSH；控制面、DERP、SSH 均在回环，无真实账户。
func TestTailnetSSHWithLocalControl(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, name := range []string{"TS_AUTHKEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE"} {
		t.Setenv(name, "")
	}
	envknob.SetNoLogsNoSupport()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	control := &testcontrol.Server{
		DERPMap:   integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"),
		DNSConfig: &tailcfg.DNSConfig{Proxied: true}, MagicDNSDomain: "litch.test", Logf: logger.Discard,
	}
	control.HTTPTestServer = httptest.NewServer(control)
	t.Cleanup(control.HTTPTestServer.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	remote := &tsnet.Server{Dir: t.TempDir(), Hostname: "server", ControlURL: control.HTTPTestServer.URL, Logf: logger.Discard, UserLogf: logger.Discard}
	t.Cleanup(func() { _ = remote.Close() })
	if _, err := remote.Up(ctx); err != nil {
		t.Fatal(err)
	}
	listener, err := remote.Listen("tcp", ":2222")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	signer, private := newKey(t)
	sshServer := startServer(t, signer.PublicKey())
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				local, err := net.Dial("tcp", sshServer.address)
				if err != nil {
					return
				}
				defer local.Close()
				go func() { _, _ = io.Copy(local, connection); _ = local.Close() }()
				_, _ = io.Copy(connection, local)
			}()
		}
	}()
	if err := TailscaleInitialize(t.TempDir(), "client", &testTailStorage{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = TailscaleStop()
		tailNode.Lock()
		tailNode.storage = nil
		tailNode.store = nil
		tailNode.paused = false
		tailNode.resume = false
		tailNode.Unlock()
	})
	// 仅测试绕过公共 HTTPS 输入校验，以本地临时控制面启动。
	if err := tailNode.store.setControl(control.HTTPTestServer.URL); err != nil {
		t.Fatal(err)
	}
	tailNode.Lock()
	err = startTailLocked()
	tailNode.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	lc, _ := tailNode.server.LocalClient()
	for {
		status, err := lc.Status(ctx)
		if err == nil && status.BackendState == "Running" {
			if _, err := tailAddress("server", 2222, status); err == nil {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("节点未就绪", ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	before, err := lc.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := ProbeHost("server", 2222, "test", true)
	if err != nil {
		t.Fatal(err)
	}
	var host hostDescription
	if err = json.Unmarshal([]byte(encoded), &host); err != nil {
		t.Fatal(err)
	}
	if host.Fingerprint != ssh.FingerprintSHA256(sshServer.host) {
		t.Fatal("探测没有经过同一个 SSH 主机")
	}
	target := Target{Host: "server.litch.test", Port: 2222, User: "test", PrivateKey: private, HostFingerprint: host.Fingerprint, Tailscale: true}
	client, err := connectSSH(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	wrong := target
	wrong.HostFingerprint = "SHA256:wrong"
	if _, err := connectSSH(ctx, wrong); err == nil || !strings.Contains(err.Error(), "[hostKeyChanged]") {
		t.Fatal("指纹未钉住", err)
	}
	_, other := newKey(t)
	wrong = target
	wrong.PrivateKey = other
	if _, err := connectSSH(ctx, wrong); err == nil || !strings.Contains(err.Error(), "[auth]") {
		t.Fatal("私钥未校验", err)
	}
	done := make(chan struct{})
	go func() { _ = client.Wait(); close(done) }()
	pauseTailscale(true)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("后台到期未关闭 SSH")
	}
	paused, err := TailscaleStatus()
	if err != nil || !strings.Contains(paused, `"suspended"`) {
		t.Fatal(paused, err)
	}
	pauseTailscale(false)
	if _, err := TailscaleStatus(); err != nil {
		t.Fatal(err)
	}
	lc, _ = tailNode.server.LocalClient()
	for {
		after, err := lc.Status(ctx)
		if err == nil && after.BackendState == "Running" && len(after.TailscaleIPs) > 0 {
			if after.TailscaleIPs[0] != before.TailscaleIPs[0] {
				t.Fatal("恢复后重复注册了节点")
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("恢复超时")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := TailscaleLogout(); err != nil {
		t.Fatal(err)
	}
	if _, err := dialTailscale(ctx, "server", 2222); err == nil || !strings.Contains(err.Error(), "[tailscaleLogin]") {
		t.Fatal("退出后仍可拨号", err)
	}
	if err := TailscaleClear(); err != nil {
		t.Fatal(err)
	}
}
