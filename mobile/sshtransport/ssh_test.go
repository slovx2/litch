package sshtransport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// 回环上的一个最小 SSH 服务：只认一把钥匙，不开任何通道。answer 为假时不回心跳（模拟网络静默断开）
type testServer struct {
	address string
	host    ssh.PublicKey
	answer  atomic.Bool
}

func newKey(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "test")
	if err != nil {
		t.Fatal(err)
	}
	return signer, string(pem.EncodeToMemory(block))
}

func startServer(t *testing.T, allowed ssh.PublicKey) *testServer {
	t.Helper()
	hostSigner, _ := newKey(t)
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), allowed.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, net.ErrClosed
		},
	}
	config.AddHostKey(hostSigner)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	server := &testServer{address: listener.Addr().String(), host: hostSigner.PublicKey()}
	server.answer.Store(true)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_, channels, requests, err := ssh.NewServerConn(connection, config)
				if err != nil {
					_ = connection.Close()
					return
				}
				go func() {
					for channel := range channels {
						_ = channel.Reject(ssh.Prohibited, "测试服务不开通道")
					}
				}()
				for request := range requests {
					if server.answer.Load() && request.WantReply {
						_ = request.Reply(true, nil)
					}
				}
			}()
		}
	}()
	return server
}

func (s *testServer) target(t *testing.T, privateKey, fingerprint string) Target {
	t.Helper()
	host, port, _ := net.SplitHostPort(s.address)
	var number int
	if err := json.Unmarshal([]byte(port), &number); err != nil {
		t.Fatal(err)
	}
	return Target{Host: host, Port: number, User: "test", PrivateKey: privateKey, HostFingerprint: fingerprint}
}

func TestProbeHostReportsFingerprint(t *testing.T) {
	client, _ := newKey(t)
	server := startServer(t, client.PublicKey())
	target := server.target(t, "", "")
	encoded, err := ProbeHost(target.Host, target.Port, target.User)
	if err != nil {
		t.Fatal(err)
	}
	var described hostDescription
	if err := json.Unmarshal([]byte(encoded), &described); err != nil {
		t.Fatal(err)
	}
	if described.Fingerprint != ssh.FingerprintSHA256(server.host) || described.KeyType != ssh.KeyAlgoED25519 {
		t.Fatalf("指纹不对: %+v", described)
	}
}

func TestConnectClassifiesFailures(t *testing.T) {
	client, privateKey := newKey(t)
	_, otherKey := newKey(t)
	server := startServer(t, client.PublicKey())
	pinned := ssh.FingerprintSHA256(server.host)
	other, _ := newKey(t)

	_, err := connectSSH(t.Context(), server.target(t, privateKey, ""))
	expectKind(t, err, kindHostKeyUnknown)
	_, err = connectSSH(t.Context(), server.target(t, privateKey, ssh.FingerprintSHA256(other.PublicKey())))
	expectKind(t, err, kindHostKeyChanged)
	_, err = connectSSH(t.Context(), server.target(t, otherKey, pinned))
	expectKind(t, err, kindAuth)
	_, err = connectSSH(t.Context(), server.target(t, "坏的", pinned))
	expectKind(t, err, kindKey)

	connected, err := connectSSH(t.Context(), server.target(t, privateKey, pinned))
	if err != nil {
		t.Fatal(err)
	}
	_ = connected.Close()

	closed, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := closed.Addr().String()
	_ = closed.Close()
	host, port, _ := net.SplitHostPort(address)
	var number int
	_ = json.Unmarshal([]byte(port), &number)
	_, err = connectSSH(t.Context(), Target{Host: host, Port: number, User: "test", PrivateKey: privateKey, HostFingerprint: pinned})
	expectKind(t, err, kindUnreachable)
}

func TestKeepAliveClosesSilentConnection(t *testing.T) {
	every, wait := keepAliveEvery, keepAliveWait
	keepAliveEvery, keepAliveWait = 50*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { keepAliveEvery, keepAliveWait = every, wait })

	client, privateKey := newKey(t)
	server := startServer(t, client.PublicKey())
	connected, err := connectSSH(t.Context(), server.target(t, privateKey, ssh.FingerprintSHA256(server.host)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reasons := make(chan string, 1)
	go keepAlive(ctx, connected, func(reason string) { reasons <- reason })

	// 回音正常时一直连着
	time.Sleep(300 * time.Millisecond)
	select {
	case reason := <-reasons:
		t.Fatalf("有回音时不该断: %s", reason)
	default:
	}

	server.answer.Store(false)
	select {
	case reason := <-reasons:
		if !strings.Contains(reason, "没有回音") {
			t.Fatalf("原因不对: %s", reason)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("对面不回心跳，连接没有被关掉")
	}
	// 连接已经关了：再开会话会失败
	if _, err := connected.NewSession(); err == nil {
		t.Fatal("连接应该已经关掉")
	}
}
