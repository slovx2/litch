// Copyright (c) 2026 tyrs-hand contributors. SPDX-License-Identifier: MIT
package sshserver

import (
	"errors"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"sync"
	"time"
)

func (s *SSHServer) serveDesktop(channel ssh.Channel) error {
	return s.serveDesktopInput(channel, channel)
}

func (s *SSHServer) serveDesktopInput(channel ssh.Channel, input io.Reader) error {
	// SSH Channel 没有 net.Conn 所需的地址和 deadline，并且客户端关闭 stdin 时
	// 必须只向 App Server 传播读 EOF，不能截断仍在返回的数据。
	serverConnection, proxyConnection := newDesktopPipe()
	type proxyResult struct {
		source string
		err    error
	}
	finished := make(chan proxyResult, 3)
	go func() {
		finished <- proxyResult{source: "runtime", err: s.options.Runtime.ServeDesktop(serverConnection)}
	}()
	go func() {
		_, err := io.Copy(proxyConnection, input)
		closeErr := proxyConnection.CloseWrite()
		if err == nil && closeErr != nil && !errors.Is(closeErr, io.ErrClosedPipe) &&
			!errors.Is(closeErr, net.ErrClosed) {
			err = closeErr
		}
		finished <- proxyResult{source: "input", err: err}
	}()
	go func() {
		_, err := io.Copy(channel, proxyConnection)
		finished <- proxyResult{source: "output", err: err}
	}()
	var result proxyResult
	var runtimeErr error
	for {
		result = <-finished
		if result.source == "input" && (result.err == nil || errors.Is(result.err, io.EOF) ||
			errors.Is(result.err, net.ErrClosed)) {
			// SSH exec 可以先结束输入、再继续读取 App Server 输出，不能据此截断反向数据。
			continue
		}
		if result.source == "runtime" {
			runtimeErr = result.err
			_ = serverConnection.Close()
			for result.source != "output" {
				result = <-finished
			}
		}
		break
	}
	_ = serverConnection.Close()
	_ = proxyConnection.Close()
	if runtimeErr != nil && !errors.Is(runtimeErr, io.EOF) && !errors.Is(runtimeErr, net.ErrClosed) {
		return runtimeErr
	}
	if errors.Is(result.err, io.EOF) || errors.Is(result.err, net.ErrClosed) {
		return nil
	}
	return result.err
}

type desktopPipeConnection struct {
	reader    net.Conn
	writer    net.Conn
	local     net.Addr
	remote    net.Addr
	closeOnce sync.Once
}

type desktopPipeAddress string

func newDesktopPipe() (*desktopPipeConnection, *desktopPipeConnection) {
	serverReader, proxyWriter := net.Pipe()
	proxyReader, serverWriter := net.Pipe()
	server := &desktopPipeConnection{reader: serverReader, writer: serverWriter,
		local: desktopPipeAddress("harness-runtime"), remote: desktopPipeAddress("ssh-client")}
	proxy := &desktopPipeConnection{reader: proxyReader, writer: proxyWriter,
		local: desktopPipeAddress("ssh-client"), remote: desktopPipeAddress("harness-runtime")}
	return server, proxy
}

func (c *desktopPipeConnection) Read(value []byte) (int, error)  { return c.reader.Read(value) }
func (c *desktopPipeConnection) Write(value []byte) (int, error) { return c.writer.Write(value) }
func (c *desktopPipeConnection) CloseWrite() error               { return c.writer.Close() }

func (c *desktopPipeConnection) Close() error {
	var result error
	c.closeOnce.Do(func() { result = errors.Join(c.reader.Close(), c.writer.Close()) })
	return result
}

func (c *desktopPipeConnection) LocalAddr() net.Addr  { return c.local }
func (c *desktopPipeConnection) RemoteAddr() net.Addr { return c.remote }
func (c *desktopPipeConnection) SetDeadline(deadline time.Time) error {
	return errors.Join(c.reader.SetReadDeadline(deadline), c.writer.SetWriteDeadline(deadline))
}
func (c *desktopPipeConnection) SetReadDeadline(deadline time.Time) error {
	return c.reader.SetReadDeadline(deadline)
}
func (c *desktopPipeConnection) SetWriteDeadline(deadline time.Time) error {
	return c.writer.SetWriteDeadline(deadline)
}
func (a desktopPipeAddress) Network() string { return "ssh-pipe" }
func (a desktopPipeAddress) String() string  { return string(a) }
