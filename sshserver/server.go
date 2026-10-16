// Copyright (c) 2026 tyrs-hand contributors. SPDX-License-Identifier: MIT
package sshserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"

	"github.com/slovx2/litch/internal/hostplatform"
	"go.uber.org/zap"
	"golang.org/x/crypto/ssh"
)

type AuthorizedClient struct {
	ID        string
	PublicKey ssh.PublicKey
}

type SSHOptions struct {
	ListenAddr        string
	HostKeyFile       string
	Home              string
	CodexHome         string
	Shell             string
	AuthorizedClients []AuthorizedClient
	Authorization     *ClientAuthorization
	Runtime           DesktopServer
	Command           func(context.Context, string, io.ReadWriteCloser) (bool, uint32)
	Environment       func() []string
	EntryBin          string
	Forward           func(context.Context, ssh.NewChannel)
	Logger            *zap.Logger
}

type DesktopServer interface {
	ServeDesktop(net.Conn) error
}

type SSHServer struct {
	context            context.Context
	cancel             context.CancelFunc
	options            SSHOptions
	listener           net.Listener
	config             *ssh.ServerConfig
	hostKeyFingerprint string

	mu             sync.Mutex
	connections    map[*ssh.ServerConn]struct{}
	rawConnections map[net.Conn]struct{}
	closed         bool
	wg             sync.WaitGroup
}

func StartSSHServer(ctx context.Context, options SSHOptions) (*SSHServer, error) {
	if options.ListenAddr == "" || options.HostKeyFile == "" || options.Home == "" ||
		options.CodexHome == "" || options.Runtime == nil {
		return nil, errors.New("SSH Server 配置不完整")
	}
	if options.Shell == "" {
		options.Shell = hostplatform.DefaultShell()
	}
	if options.Logger == nil {
		options.Logger = zap.NewNop()
	}
	signer, err := LoadOrCreateHostKey(options.HostKeyFile)
	if err != nil {
		return nil, err
	}
	if options.Authorization == nil {
		options.Authorization = NewClientAuthorization(options.AuthorizedClients)
	}
	configuration := &ssh.ServerConfig{
		PublicKeyCallback: func(metadata ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			clientID, ok := options.Authorization.Lookup(string(key.Marshal()))
			if !ok {
				options.Logger.Warn("拒绝未授权 SSH SSH 公钥",
					zap.String("fingerprint", ssh.FingerprintSHA256(key)),
					zap.String("remote", metadata.RemoteAddr().String()))
				return nil, errors.New("SSH 公钥未授权")
			}
			return &ssh.Permissions{Extensions: map[string]string{"client-id": clientID, "client-key": string(key.Marshal())}}, nil
		},
		MaxAuthTries: 3,
	}
	configuration.AddHostKey(signer)
	listener, err := net.Listen("tcp", options.ListenAddr)
	if err != nil {
		return nil, fmt.Errorf("监听 SSH SSH: %w", err)
	}
	ctx, cancel := context.WithCancel(ctx)
	server := &SSHServer{context: ctx, cancel: cancel, options: options, listener: listener, config: configuration,
		hostKeyFingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
		connections:        make(map[*ssh.ServerConn]struct{}), rawConnections: make(map[net.Conn]struct{})}
	options.Authorization.mu.Lock()
	options.Authorization.servers[server] = struct{}{}
	options.Authorization.mu.Unlock()
	server.wg.Add(1)
	go server.serve(ctx)
	return server, nil
}

func (s *SSHServer) Addr() net.Addr { return s.listener.Addr() }

func (s *SSHServer) HostKeyFingerprint() string { return s.hostKeyFingerprint }

func (s *SSHServer) Close() error {
	s.cancel()
	s.options.Authorization.mu.Lock()
	delete(s.options.Authorization.servers, s)
	s.options.Authorization.mu.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.wg.Wait()
		return nil
	}
	s.closed = true
	_ = s.listener.Close()
	for connection := range s.rawConnections {
		_ = connection.Close()
	}
	for connection := range s.connections {
		_ = connection.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}

func (s *SSHServer) serve(ctx context.Context) {
	defer s.wg.Done()
	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()
	for {
		raw, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go s.handleConnection(raw)
	}
}

func (s *SSHServer) handleConnection(raw net.Conn) {
	defer s.wg.Done()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = raw.Close()
		return
	}
	// 握手尚未完成的 TCP 连接也必须在关闭服务时释放。
	s.rawConnections[raw] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.rawConnections, raw)
		s.mu.Unlock()
		_ = raw.Close()
	}()
	ctx, cancel := context.WithCancel(s.context)
	defer cancel()
	connection, channels, requests, err := ssh.NewServerConn(raw, s.config)
	if err != nil {
		_ = raw.Close()
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = connection.Close()
		return
	}
	s.connections[connection] = struct{}{}
	s.mu.Unlock()
	if id, ok := s.options.Authorization.Lookup(connection.Permissions.Extensions["client-key"]); !ok || id != connection.Permissions.Extensions["client-id"] {
		_ = connection.Close()
	}
	defer func() {
		s.mu.Lock()
		delete(s.connections, connection)
		s.mu.Unlock()
		_ = connection.Close()
	}()
	go ssh.DiscardRequests(requests)
	for request := range channels {
		if request.ChannelType() == "direct-tcpip" {
			if s.options.Forward != nil {
				s.options.Forward(ctx, request)
			} else {
				_ = request.Reject(ssh.Prohibited, "禁止端口转发")
			}
			continue
		}
		if request.ChannelType() != "session" {
			_ = request.Reject(ssh.Prohibited, "SSH 禁止 SSH 转发")
			continue
		}
		channel, channelRequests, err := request.Accept()
		if err != nil {
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleSession(ctx, channel, channelRequests)
		}()
	}
}

type sshSessionState struct {
	mu          sync.Mutex
	environment map[string]string
	term        string
	columns     uint32
	rows        uint32
	started     bool
	resize      func(uint32, uint32) error
}

func (s *SSHServer) handleSession(ctx context.Context, channel ssh.Channel, requests <-chan *ssh.Request) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer func() { _ = channel.Close() }()
	state := &sshSessionState{environment: make(map[string]string), columns: 80, rows: 24}
	done := make(chan struct{})
	start := func(run func()) {
		s.wg.Add(1)
		go func() { defer s.wg.Done(); defer close(done); run() }()
	}
	for {
		var request *ssh.Request
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case next, ok := <-requests:
			if !ok {
				return
			}
			request = next
		}
		switch request.Type {
		case "env":
			var input struct{ Name, Value string }
			if ssh.Unmarshal(request.Payload, &input) == nil && !state.started {
				state.environment[input.Name] = input.Value
				_ = request.Reply(true, nil)
			} else {
				_ = request.Reply(false, nil)
			}
		case "pty-req":
			var input struct {
				Term                         string
				Columns, Rows, Width, Height uint32
				Modes                        string
			}
			if ssh.Unmarshal(request.Payload, &input) == nil && !state.started {
				state.term, state.columns, state.rows = input.Term, input.Columns, input.Rows
				_ = request.Reply(true, nil)
			} else {
				_ = request.Reply(false, nil)
			}
		case "window-change":
			var input struct{ Columns, Rows, Width, Height uint32 }
			if ssh.Unmarshal(request.Payload, &input) == nil {
				state.mu.Lock()
				state.columns, state.rows = input.Columns, input.Rows
				var resizeErr error
				if state.resize != nil {
					resizeErr = state.resize(input.Columns, input.Rows)
				}
				state.mu.Unlock()
				_ = request.Reply(resizeErr == nil, nil)
			} else {
				_ = request.Reply(false, nil)
			}
		case "subsystem":
			var input struct{ Name string }
			if ssh.Unmarshal(request.Payload, &input) == nil && input.Name == "sftp" && !state.started {
				state.started = true
				_ = request.Reply(true, nil)
				start(func() { s.serveSFTP(channel) })
				continue
			}
			_ = request.Reply(false, nil)
		case "exec":
			var input struct{ Command string }
			if ssh.Unmarshal(request.Payload, &input) != nil || state.started {
				_ = request.Reply(false, nil)
				continue
			}
			state.started = true
			_ = request.Reply(true, nil)
			start(func() { s.runCommand(ctx, channel, state, input.Command) })
		case "shell":
			if state.started {
				_ = request.Reply(false, nil)
				continue
			}
			state.started = true
			_ = request.Reply(true, nil)
			start(func() { s.runShell(ctx, channel, state) })
		default:
			_ = request.Reply(false, nil)
		}
	}
}
