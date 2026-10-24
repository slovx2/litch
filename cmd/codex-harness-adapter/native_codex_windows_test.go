//go:build windows

package main

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/slovx2/litch/internal/hostplatform"
)

// Windows 上 app-server 听在状态目录里它自己建的那层目录下的 AF_UNIX 上，命令行只给 unix://。
func TestCodexListensOnUnixSocketOnWindows(t *testing.T) {
	cfg := settingsTestConfiguration(t).forHarness(nativeCodex)
	want := filepath.Join(cfg.directory(), "app-server", "runtime.sock")
	if got := codexSocketPath(cfg); got != want {
		t.Fatalf("套接字应在 %s，得到 %s", want, got)
	}
	command := codexCommand(cfg, `C:\codex\codex.exe`)
	if !slices.Equal(command.Args[1:], []string{"app-server", "--listen", "unix://" + want}) {
		t.Fatalf("起 app-server 的参数不对: %q", command.Args)
	}
}

// 命名管道上来的连接原样转到 app-server 的 AF_UNIX 上；停掉之后管道没了，还连着的也断开。
func TestCodexBridgeRelaysPipeToUnixSocket(t *testing.T) {
	cfg := settingsTestConfiguration(t).forHarness(nativeCodex)
	if err := os.MkdirAll(filepath.Dir(codexSocketPath(cfg)), 0o700); err != nil {
		t.Fatal(err)
	}
	upstream, err := net.Listen("unix", codexSocketPath(cfg))
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			connection, err := upstream.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					_, _ = connection.Write([]byte("echo " + line))
				}
			}()
		}
	}()
	probe, err := dialRuntime(cfg)
	if err != nil {
		t.Fatalf("就绪检查应直接连 app-server 的套接字: %v", err)
	}
	probe.Close()
	stop, err := bridgeCodex(cfg)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := hostplatform.Dial(cfg.socket())
	if err != nil {
		t.Fatalf("连不上转发的命名管道: %v", err)
	}
	defer connection.Close()
	reader := bufio.NewReader(connection)
	for _, text := range []string{"one\n", "two\n"} {
		if _, err := connection.Write([]byte(text)); err != nil {
			t.Fatal(err)
		}
		if line, err := reader.ReadString('\n'); err != nil || line != "echo "+text {
			t.Fatalf("经管道收到的不对: %q %v", line, err)
		}
	}
	stop()
	if _, err := reader.ReadString('\n'); err == nil {
		t.Fatal("停掉转发之后还连着的应断开")
	}
	if extra, err := hostplatform.Dial(cfg.socket()); err == nil {
		extra.Close()
		t.Fatal("停掉转发之后管道不该还在")
	}
}
