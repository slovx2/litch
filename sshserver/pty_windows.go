package sshserver

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
	"github.com/slovx2/litch/internal/hostplatform"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/windows"
)

func (s *SSHServer) runPTY(ctx context.Context, channel ssh.Channel, state *sshSessionState, process *exec.Cmd) {
	state.mu.Lock()
	terminal, err := conpty.Start(windows.ComposeCommandLine(process.Args), conpty.ConPtyDimensions(int(state.columns), int(state.rows)), conpty.ConPtyWorkDir(process.Dir), conpty.ConPtyEnv(process.Env))
	if err == nil {
		state.resize = func(cols, rows uint32) error { return terminal.Resize(int(cols), int(rows)) }
	}
	state.mu.Unlock()
	if err != nil {
		s.writeExit(channel, 1)
		return
	}
	cleanup, err := hostplatform.TrackPID(terminal.Pid())
	if err != nil {
		_ = terminal.Close()
		s.writeExit(channel, 1)
		return
	}
	var once sync.Once
	closeTerminal := func() {
		once.Do(func() { state.mu.Lock(); state.resize = nil; cleanup(); _ = terminal.Close(); state.mu.Unlock() })
	}
	defer closeTerminal()
	stop := context.AfterFunc(ctx, closeTerminal)
	defer stop()
	drained := make(chan struct{})
	go func() { _, _ = io.Copy(terminal, channel); closeTerminal() }()
	go func() { _, _ = io.Copy(channel, terminal); close(drained) }()
	code, err := terminal.Wait(context.Background())
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
	}
	if err != nil {
		code = 1
	}
	s.writeExit(channel, code)
}
