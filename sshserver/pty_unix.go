//go:build !windows

package sshserver

import (
	"context"
	"github.com/creack/pty"
	"golang.org/x/crypto/ssh"
	"io"
	"os/exec"
)

func (s *SSHServer) runPTY(_ context.Context, channel ssh.Channel, state *sshSessionState, process *exec.Cmd) {
	state.mu.Lock()
	terminal, err := pty.StartWithSize(process, &pty.Winsize{
		Cols: uint16(state.columns), Rows: uint16(state.rows),
	})
	if err != nil {
		state.mu.Unlock()
		s.writeExit(channel, 1)
		return
	}
	state.resize = func(cols, rows uint32) error {
		return pty.Setsize(terminal, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	}
	state.mu.Unlock()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(terminal, channel)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(channel, terminal)
		done <- struct{}{}
	}()
	err = process.Wait()
	state.mu.Lock()
	state.resize = nil
	_ = terminal.Close()
	state.mu.Unlock()
	<-done
	s.writeExit(channel, exitStatus(err))
}
