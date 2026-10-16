package sshserver

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/slovx2/litch/internal/hostplatform"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"
)

type desktopStub struct{}

func TestCloseReleasesIncompleteHandshake(t *testing.T) {
	server, err := StartSSHServer(context.Background(), SSHOptions{
		ListenAddr: "127.0.0.1:0", HostKeyFile: filepath.Join(t.TempDir(), "host_key"),
		Home: t.TempDir(), CodexHome: t.TempDir(), Runtime: desktopStub{},
	})
	require.NoError(t, err)
	client, err := net.Dial("tcp", server.Addr().String())
	require.NoError(t, err)
	defer client.Close()
	// 收到服务端版本头，确认连接已进入 SSH 握手；客户端不发送任何字节。
	require.NoError(t, client.SetReadDeadline(time.Now().Add(time.Second)))
	buffer := make([]byte, 128)
	_, err = client.Read(buffer)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- server.Close() }()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(time.Second):
		_ = client.Close()
		<-done
		t.Fatal("未完成的 SSH 握手阻止了退出")
	}
}

func (desktopStub) ServeDesktop(connection net.Conn) error {
	_, err := connection.Write([]byte("desktop-proxy"))
	return err
}

type desktopWebSocketStub struct{}

func (desktopWebSocketStub) ServeDesktop(connection net.Conn) error {
	done := make(chan struct{})
	tracked := &testSignalConnection{Conn: connection, done: done}
	listener := &testSingleConnectionListener{connection: tracked, done: done}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter,
		request *http.Request,
	) {
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(response, request, nil)
		if err == nil {
			_ = ws.WriteMessage(websocket.TextMessage, []byte("ready"))
			_ = ws.Close()
		}
	})}
	err := server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

type testSingleConnectionListener struct {
	connection net.Conn
	done       chan struct{}
	once       sync.Once
}

func (l *testSingleConnectionListener) Accept() (net.Conn, error) {
	var connection net.Conn
	l.once.Do(func() { connection = l.connection })
	if connection != nil {
		return connection, nil
	}
	<-l.done
	return nil, net.ErrClosed
}

func (l *testSingleConnectionListener) Close() error   { return l.connection.Close() }
func (l *testSingleConnectionListener) Addr() net.Addr { return l.connection.LocalAddr() }

type testSignalConnection struct {
	net.Conn
	done chan struct{}
	once sync.Once
}

func (c *testSignalConnection) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Conn.Close()
}

type testSSHConnection struct{ ssh.Channel }

func (testSSHConnection) LocalAddr() net.Addr              { return testAddress("client") }
func (testSSHConnection) RemoteAddr() net.Addr             { return testAddress("worker") }
func (testSSHConnection) SetDeadline(time.Time) error      { return nil }
func (testSSHConnection) SetReadDeadline(time.Time) error  { return nil }
func (testSSHConnection) SetWriteDeadline(time.Time) error { return nil }

type testAddress string

func (a testAddress) Network() string { return "ssh" }
func (a testAddress) String() string  { return string(a) }

func TestSSHServerSupportsShellProxyAndRejectsForwarding(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := ssh.NewSignerFromKey(private)
	require.NoError(t, err)
	publicKey, err := ssh.NewPublicKey(public)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	server, err := StartSSHServer(ctx, SSHOptions{
		ListenAddr: "127.0.0.1:0", HostKeyFile: filepath.Join(t.TempDir(), "host_key"),
		Home: t.TempDir(), CodexHome: t.TempDir(), Shell: hostplatform.DefaultShell(),
		AuthorizedClients: []AuthorizedClient{{ID: "desktop", PublicKey: publicKey}},
		Runtime:           desktopStub{},
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Close()) })
	require.Regexp(t, `^SHA256:[A-Za-z0-9+/]{43}$`, server.HostKeyFingerprint())
	client, err := ssh.Dial("tcp", server.Addr().String(), &ssh.ClientConfig{
		User: "ignored", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })

	session, err := client.NewSession()
	require.NoError(t, err)
	output, err := session.Output("printf host-shell")
	require.NoError(t, err)
	require.Equal(t, "host-shell", string(output))

	// proxy 或普通进程退出时，不能等待仍然保持打开的客户端 stdin。
	session, err = client.NewSession()
	require.NoError(t, err)
	openInput, err := session.StdinPipe()
	require.NoError(t, err)
	inputSession := session
	t.Cleanup(func() { _ = openInput.Close(); _ = inputSession.Close() })
	finished := make(chan error, 1)
	go func() { finished <- inputSession.Run("exit 0") }()
	select {
	case err := <-finished:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("远程进程已经退出，SSH 却仍等待客户端输入 EOF")
	}

	session, err = client.NewSession()
	require.NoError(t, err)
	output, err = session.Output("codex app-server proxy")
	require.NoError(t, err)
	require.Equal(t, "desktop-proxy", string(output))

	session, err = client.NewSession()
	require.NoError(t, err)
	wrapped := `printf '%b' '\033\124\376\322\310\106\334\116'; ` +
		`PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH; codex app-server proxy`
	output, err = session.Output(wrapped)
	require.NoError(t, err)
	require.Equal(t, append([]byte{0x1b, 'T', 0xfe, 0xd2, 0xc8, 'F', 0xdc, 'N'},
		[]byte("desktop-proxy")...), output)

	session, err = client.NewSession()
	require.NoError(t, err)
	output, err = session.Output(remoteDesktopLauncherFixture)
	require.NoError(t, err)
	require.Equal(t, append([]byte{0xfb, 0xe9, 0x83, 0xd6, ',', 0x10, 0xb5, 0x9b},
		[]byte("desktop-proxy")...), output)

	session, err = client.NewSession()
	require.NoError(t, err)
	stdin, err := session.StdinPipe()
	require.NoError(t, err)
	stdout, err := session.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, session.Shell())
	_, err = io.WriteString(stdin, wrapped+"\n")
	require.NoError(t, err)
	shellOutput := make([]byte, 8+len("desktop-proxy"))
	_, err = io.ReadFull(stdout, shellOutput)
	require.NoError(t, err)
	require.Equal(t, append([]byte{0x1b, 'T', 0xfe, 0xd2, 0xc8, 'F', 0xdc, 'N'},
		[]byte("desktop-proxy")...), shellOutput)
	require.NoError(t, session.Wait())

	session, err = client.NewSession()
	require.NoError(t, err)
	stdin, err = session.StdinPipe()
	require.NoError(t, err)
	stdout, err = session.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, session.Shell())
	_, err = io.WriteString(stdin, "printf shell-fallback\n")
	require.NoError(t, err)
	require.NoError(t, stdin.Close())
	fallbackOutput, err := io.ReadAll(stdout)
	require.NoError(t, err)
	require.Equal(t, "shell-fallback", string(fallbackOutput))
	require.NoError(t, session.Wait())

	_, err = client.Dial("tcp", "127.0.0.1:80")
	require.Error(t, err)
}

func TestSSHServerDesktopProxyCompletesWebSocketHandshakeWithoutEOF(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := ssh.NewSignerFromKey(private)
	require.NoError(t, err)
	publicKey, err := ssh.NewPublicKey(public)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	server, err := StartSSHServer(ctx, SSHOptions{
		ListenAddr: "127.0.0.1:0", HostKeyFile: filepath.Join(t.TempDir(), "host_key"),
		Home: t.TempDir(), CodexHome: t.TempDir(), Shell: hostplatform.DefaultShell(),
		AuthorizedClients: []AuthorizedClient{{ID: "desktop", PublicKey: publicKey}},
		Runtime:           desktopWebSocketStub{},
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Close()) })
	client, err := ssh.Dial("tcp", server.Addr().String(), &ssh.ClientConfig{
		User: "ignored", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })
	channel, requests, err := client.OpenChannel("session", nil)
	require.NoError(t, err)
	go ssh.DiscardRequests(requests)
	accepted, err := channel.SendRequest("exec", true,
		ssh.Marshal(struct{ Command string }{"codex app-server proxy"}))
	require.NoError(t, err)
	require.True(t, accepted)

	connected := make(chan *websocket.Conn, 1)
	failure := make(chan error, 1)
	go func() {
		dialer := websocket.Dialer{NetDialContext: func(context.Context, string, string) (
			net.Conn, error,
		) {
			return testSSHConnection{Channel: channel}, nil
		}}
		ws, response, dialErr := dialer.DialContext(context.Background(),
			"ws://localhost/", http.Header{})
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		if dialErr != nil {
			failure <- dialErr
			return
		}
		connected <- ws
	}()
	select {
	case ws := <-connected:
		_, message, readErr := ws.ReadMessage()
		require.NoError(t, readErr)
		require.Equal(t, "ready", string(message))
		_ = ws.Close()
	case dialErr := <-failure:
		require.NoError(t, dialErr)
	case <-time.After(time.Second):
		t.Fatal("Desktop WebSocket 握手等待了客户端 EOF")
	}
}
