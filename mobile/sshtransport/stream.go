package sshtransport

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// 一条流：手机本机回环上开一个只接一次的 WebSocket 入口，界面连上来之后，
// 原样转发到远端 `exec sh` 跑的代理脚本上（标记那一行之后，那条 ssh 的标准输入输出就是设备服务的套接字）。
type stream struct {
	id       string
	target   Target
	script   string
	marker   string
	token    string
	listener net.Listener
	client   *ssh.Client
	ctx      context.Context
	cancel   context.CancelFunc

	mu      sync.Mutex
	local   net.Conn
	session *ssh.Session
	state   streamState
	once    sync.Once
}

// streamState 给界面看：连的是哪一种、为什么断了
type streamState struct {
	Peer   string `json:"peer"`
	Error  string `json:"error"`
	Code   int    `json:"code"`
	Stderr string `json:"stderr"`
	Closed bool   `json:"closed"`
}

var streams = struct {
	sync.Mutex
	items map[string]*stream
}{items: make(map[string]*stream)}

type streamEndpoint struct {
	URL string `json:"url"`
}

// OpenStream 连上 SSH，返回界面要连的本机 WebSocket 地址（JSON：streamEndpoint）。
// 同一个 id 再开一次会先关掉上一条
func OpenStream(id, targetJSON, script, marker string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("流的 id 不能为空")
	}
	target, err := parseTarget(targetJSON)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(context.Background())
	client, err := connectSSH(ctx, target)
	if err != nil {
		cancel()
		return "", err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		cancel()
		_ = client.Close()
		return "", err
	}
	token, err := randomToken()
	if err != nil {
		cancel()
		_ = listener.Close()
		_ = client.Close()
		return "", err
	}
	s := &stream{id: id, target: target, script: script, marker: marker, token: token,
		listener: listener, client: client, ctx: ctx, cancel: cancel}
	streams.Lock()
	previous := streams.items[id]
	streams.items[id] = s
	streams.Unlock()
	if previous != nil {
		previous.close()
	}
	go keepAlive(ctx, client, func(reason string) { s.fail("%s", reason) })
	go s.serve()
	return marshalJSON(streamEndpoint{URL: "ws://" + listener.Addr().String() + "/" + token})
}

// StreamState 返回一条流现在的状态（JSON：streamState）。没有这条流时 closed 为 true
func StreamState(id string) (string, error) {
	streams.Lock()
	s := streams.items[id]
	streams.Unlock()
	if s == nil {
		return marshalJSON(streamState{Closed: true})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return marshalJSON(s.state)
}

// CloseStream 关掉一条流和它的 SSH 连接
func CloseStream(id string) {
	streams.Lock()
	s := streams.items[id]
	if s != nil {
		delete(streams.items, id)
	}
	streams.Unlock()
	if s != nil {
		s.close()
	}
}

func (s *stream) fail(format string, args ...any) {
	s.mu.Lock()
	if s.state.Error == "" {
		s.state.Error = fmt.Sprintf(format, args...)
	}
	s.mu.Unlock()
}

func (s *stream) serve() {
	defer s.close()
	if listener, ok := s.listener.(*net.TCPListener); ok {
		_ = listener.SetDeadline(time.Now().Add(45 * time.Second))
	}
	for {
		local, err := s.listener.Accept()
		if err != nil {
			s.fail("界面没有连上来: %v", err)
			return
		}
		_ = local.SetReadDeadline(time.Now().Add(10 * time.Second))
		header, valid := readLegalUpgrade(local, "/"+s.token)
		if !valid {
			_ = local.Close()
			continue
		}
		_ = s.listener.Close()
		_ = local.SetDeadline(time.Time{})
		s.mu.Lock()
		s.local = local
		s.mu.Unlock()
		s.relay(local, rewriteUpgrade(header))
		return
	}
}

func (s *stream) relay(local net.Conn, header []byte) {
	session, err := newSession(s.client, s.target)
	if err != nil {
		s.fail("开 SSH 会话: %v", err)
		return
	}
	s.mu.Lock()
	s.session = session
	s.mu.Unlock()
	stdin, err := session.StdinPipe()
	if err != nil {
		s.fail("%v", err)
		return
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		s.fail("%v", err)
		return
	}
	var stderr bytes.Buffer
	session.Stderr = &stderr
	if err = session.Start(remoteCommand); err != nil {
		s.fail("启动远端脚本: %v", err)
		return
	}
	exited := make(chan int, 1)
	go func() {
		code := 0
		var exit *ssh.ExitError
		if waitErr := session.Wait(); errors.As(waitErr, &exit) {
			code = exit.ExitStatus()
		}
		s.mu.Lock()
		s.state.Code = code
		s.state.Stderr = tail(stderr.String(), 4000)
		s.mu.Unlock()
		exited <- code
	}()
	if _, err = io.WriteString(stdin, s.script); err != nil {
		s.fail("送脚本: %v", err)
		return
	}
	reader := bufio.NewReaderSize(stdout, 64*1024)
	peer, err := waitMarker(reader, s.marker, 20*time.Second)
	if err != nil {
		// 脚本没走到标记就退了：对面没装、服务没在跑。界面按 StreamState 里的退出码和原话处理
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
		}
		s.fail("远端没有接上服务: %v", err)
		return
	}
	s.mu.Lock()
	s.state.Peer = peer
	s.mu.Unlock()
	if _, err = stdin.Write(header); err != nil {
		s.fail("送握手: %v", err)
		return
	}
	done := make(chan struct{}, 1)
	go func() {
		_, _ = io.Copy(stdin, local)
		_ = stdin.Close()
		done <- struct{}{}
	}()
	_, _ = io.Copy(local, reader)
	select {
	case <-done:
	case <-time.After(time.Second):
	}
}

// waitMarker 一行一行读，直到 `<标记> <种类>` 那一行。之前的输出（登录 shell 的欢迎语之类）都丢掉
func waitMarker(reader *bufio.Reader, marker string, limit time.Duration) (string, error) {
	type result struct {
		peer string
		err  error
	}
	found := make(chan result, 1)
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if strings.HasPrefix(line, marker) {
				found <- result{peer: strings.TrimSpace(strings.TrimPrefix(line, marker))}
				return
			}
			if err != nil {
				found <- result{err: err}
				return
			}
		}
	}()
	select {
	case r := <-found:
		return r.peer, r.err
	case <-time.After(limit):
		return "", errors.New("等标记超时")
	}
}

func (s *stream) close() {
	s.once.Do(func() {
		s.cancel()
		_ = s.listener.Close()
		s.mu.Lock()
		s.state.Closed = true
		local, session := s.local, s.session
		s.mu.Unlock()
		if local != nil {
			_ = local.Close()
		}
		if session != nil {
			_ = session.Close()
		}
		_ = s.client.Close()
	})
}

func randomToken() (string, error) {
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
