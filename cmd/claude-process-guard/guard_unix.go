//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	// 停止时整组收掉（入口以独立进程组起守护进程）
	stopKillsGroup = true
	// 记下后台命令的进程身份，CLI 崩溃时补杀
	tracksBackground = true
)

func inheritedFile(fd int, name string) *os.File {
	var stat syscall.Stat_t
	if syscall.Fstat(fd, &stat) != nil {
		return nil
	}
	return os.NewFile(uintptr(fd), name)
}

// 宽限期内可能再收到一次信号：处理器要一直在，否则第二次信号按默认动作直接杀掉守护进程。
// SIGPIPE 也接住：不接的话往断了的标准输出写会让进程直接死掉；接住的信号在 CLI 那边恢复默认。
func watchSignals(stop func()) {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGPIPE)
	go func() {
		for received := range signals {
			if received != syscall.SIGPIPE {
				stop()
			}
		}
	}()
}

func (g *guard) stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopping {
		return
	}
	g.stopping = true
	if g.closed {
		g.finish()
		return
	}
	g.remember(table())
	if g.child != nil {
		_ = g.child.Process.Signal(syscall.SIGTERM)
	}
	time.AfterFunc(grace, func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.finish()
	})
}

// 调用方拿着 mu。
func (g *guard) finish() {
	g.killTracked()
	// CLI 和同组的工具继承守护进程的进程组。
	_ = syscall.Kill(-os.Getpid(), syscall.SIGKILL)
}

func killTree(entry row) {
	target := entry.pid
	if entry.pgid == entry.pid {
		target = -entry.pid
	}
	_ = syscall.Kill(target, syscall.SIGKILL)
}
