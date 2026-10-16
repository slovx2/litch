package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/slovx2/litch/internal/hostplatform"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
)

type localRuntime struct {
	socket string
	// 现在连着几条，记在常驻服务那里（harnessManager.desktops）。没人要数时为 nil。
	sessions *atomic.Int64
}

func (r localRuntime) ServeDesktop(connection net.Conn) error {
	if r.sessions != nil {
		r.sessions.Add(1)
		defer r.sessions.Add(-1)
	}
	upstream, err := hostplatform.Dial(r.socket)
	if err != nil {
		return err
	}
	defer upstream.Close()
	go func() {
		_, _ = io.Copy(upstream, connection)
		hostplatform.CloseWrite(upstream)
	}()
	_, err = io.Copy(connection, upstream)
	return err
}

func installEntry(c configuration, version string) error {
	directory := filepath.Join(c.directory(), "entry-bin")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	entry := "#!/bin/sh\nexec " + quote(hostplatform.ShellPath(executable)) + " entry " + quote(c.socket()) + " " + quote(version) + " \"$@\"\n"
	return os.WriteFile(filepath.Join(directory, "codex"), []byte(entry), 0o700)
}

func runEntry(ctx context.Context, args []string) error {
	if len(args) < 3 {
		return errors.New(tr("内部入口参数不完整", "the internal entry was called with incomplete arguments"))
	}
	socket, version, command := args[0], args[1], strings.Join(args[2:], " ")
	switch command {
	case "--version", "-V":
		fmt.Println("codex-cli " + version)
		return nil
	case "app-server daemon start":
		connection, err := hostplatform.Dial(socket)
		if err != nil {
			return err
		}
		return connection.Close()
	case "app-server proxy":
		connection, err := hostplatform.Dial(socket)
		if err != nil {
			return err
		}
		defer connection.Close()
		stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
		defer stop()
		go func() { _, _ = io.Copy(connection, os.Stdin); hostplatform.CloseWrite(connection) }()
		_, err = io.Copy(os.Stdout, connection)
		return err
	default:
		return fmt.Errorf(tr("此入口不支持 codex %s", "this entry does not support codex %s"), command)
	}
}
