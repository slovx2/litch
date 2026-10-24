//go:build windows

package main

import (
	"io"
	"net"
	"path/filepath"
	"sync"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// Windows 上 codex 的 `--listen unix://PATH` 是 AF_UNIX 套接字（codex-uds 用 uds_windows），
// 而设备进程（Node）和别的入口在 Windows 上走的是命名管道，连不了 AF_UNIX。
// 所以 app-server 听在状态目录里的一个 AF_UNIX 文件上，服务在这个 harness 平常的命名管道（c.socket()）上
// 转一道：每来一条连接就去连一次 app-server，两头原样对拷，管道里跑的还是同一份 WebSocket。
//
// 套接字所在的目录要交给 codex 自己建：它要求那一层目录只有当前用户能访问（受保护的 DACL，只有一条 ACE），
// 已经存在、权限不是它设的那种就拒绝（“socket directory is not private to the current user”，实测）。
// 状态目录里 harness 那一层是我们建的，所以再往下放一层它自己建的 app-server。
func codexSocketPath(c configuration) string {
	return filepath.Join(c.directory(), "app-server", "runtime.sock")
}

func dialCodex(c configuration) (net.Conn, error) {
	return net.DialTimeout("unix", codexSocketPath(c), 5*time.Second)
}

// 在 c.socket() 的命名管道上开始转发，返回的函数停掉转发并断开还连着的。
func bridgeCodex(c configuration) (func(), error) {
	listener, err := hostplatform.Listen(c.socket())
	if err != nil {
		return nil, err
	}
	var lock sync.Mutex
	open := map[net.Conn]struct{}{}
	track := func(connection net.Conn) bool {
		lock.Lock()
		defer lock.Unlock()
		if open == nil {
			return false
		}
		open[connection] = struct{}{}
		return true
	}
	release := func(connection net.Conn) {
		lock.Lock()
		defer lock.Unlock()
		delete(open, connection)
	}
	relay := func(connection net.Conn) {
		defer connection.Close()
		upstream, err := dialCodex(c)
		if err != nil {
			return
		}
		defer upstream.Close()
		if !track(connection) {
			return
		}
		defer release(connection)
		// 哪一头先断就两头都断：WebSocket 自己有关闭握手，用不着半关
		go func() {
			_, _ = io.Copy(upstream, connection)
			_ = upstream.Close()
			_ = connection.Close()
		}()
		_, _ = io.Copy(connection, upstream)
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go relay(connection)
		}
	}()
	return func() {
		_ = listener.Close()
		lock.Lock()
		defer lock.Unlock()
		for connection := range open {
			_ = connection.Close()
		}
		open = nil
	}, nil
}

// 服务被强杀时，它起的 app-server 由作业对象一起收掉（hostplatform.Track 设了 KILL_ON_JOB_CLOSE），
// 不会像 Unix 上那样留下没人管的进程，所以不用记进程号。
func recordCodexProcess(configuration, int) {}
func forgetCodexProcess(configuration)      {}
func reapCodexOrphan(configuration)         {}
func sweepCodexOrphan(configuration)        {}
