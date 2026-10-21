//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var guardBinary string

// 编一份真的守护进程，按入口的起法（独立进程组、文件描述符 3 和 4）来起它。
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "claude-process-guard-")
	if err != nil {
		panic(err)
	}
	guardBinary = filepath.Join(dir, "claude-process-guard")
	build := exec.Command("go", "build", "-o", guardBinary, ".")
	build.Stdout, build.Stderr = os.Stderr, os.Stderr
	if err := build.Run(); err != nil {
		panic(err)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

type session struct {
	t        *testing.T
	command  *exec.Cmd
	stdin    io.WriteCloser
	stdout   *syncBuffer
	stderr   *syncBuffer
	control  *os.File
	identity *bufio.Reader
	done     chan struct{}
}

// 测试一边读、复制的协程一边写
type syncBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func start(t *testing.T, args ...string) *session {
	t.Helper()
	identityRead, identityWrite, err := os.Pipe()
	require.NoError(t, err)
	controlRead, controlWrite, err := os.Pipe()
	require.NoError(t, err)
	command := exec.Command(guardBinary, args...)
	command.ExtraFiles = []*os.File{identityWrite, controlRead}
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	s := &session{t: t, command: command, stdout: &syncBuffer{}, stderr: &syncBuffer{}}
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	stderr, err := command.StderrPipe()
	require.NoError(t, err)
	s.stdin, err = command.StdinPipe()
	require.NoError(t, err)
	require.NoError(t, command.Start())
	_ = identityWrite.Close()
	_ = controlRead.Close()
	s.control, s.identity = controlWrite, bufio.NewReader(identityRead)
	s.done = make(chan struct{})
	copied := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(s.stdout, stdout); copied <- struct{}{} }()
	go func() { _, _ = io.Copy(s.stderr, stderr); copied <- struct{}{} }()
	go func() {
		<-copied
		<-copied
		_ = command.Wait()
		close(s.done)
	}()
	t.Cleanup(func() {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		<-s.done
	})
	return s
}

func (s *session) childPid() int {
	s.t.Helper()
	line, err := s.identity.ReadString('\n')
	require.NoError(s.t, err)
	var identity struct{ ChildPid int }
	require.NoError(s.t, json.Unmarshal([]byte(line), &identity))
	require.Positive(s.t, identity.ChildPid)
	return identity.ChildPid
}

func (s *session) wait(within time.Duration) *os.ProcessState {
	s.t.Helper()
	select {
	case <-s.done:
		return s.command.ProcessState
	case <-time.After(within):
		s.t.Fatalf("守护进程没有在 %s 内退出；输出：%q %q", within, s.stdout.String(), s.stderr.String())
		return nil
	}
}

func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func eventually(t *testing.T, within time.Duration, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(message)
}

func TestForwardsStdioReportsChildAndExitCode(t *testing.T) {
	s := start(t, "/bin/sh", "-c", `read line; printf "got:%s" "$line"; printf err >&2; exit 3`)
	require.NotEqual(t, s.command.Process.Pid, s.childPid())
	_, err := s.stdin.Write([]byte("hi\n"))
	require.NoError(t, err)
	state := s.wait(5 * time.Second)
	require.Equal(t, 3, state.ExitCode())
	require.Equal(t, "got:hi", s.stdout.String())
	require.Equal(t, "err", s.stderr.String())
}

// 标准输入结束时先不关 CLI 的输入，入口说 g 之后才关；先说 g 再结束也一样。
func TestInputEndWaitsForGraceful(t *testing.T) {
	for _, gracefulFirst := range []bool{false, true} {
		s := start(t, "/bin/sh", "-c", `cat; printf done`)
		s.childPid()
		if gracefulFirst {
			_, _ = s.control.Write([]byte("g"))
		}
		_, _ = s.stdin.Write([]byte("in-"))
		require.NoError(t, s.stdin.Close())
		if !gracefulFirst {
			time.Sleep(300 * time.Millisecond)
			select {
			case <-s.done:
				t.Fatal("没说 g 就关了 CLI 的输入")
			default:
			}
			_, _ = s.control.Write([]byte("g"))
		}
		require.Equal(t, 0, s.wait(5*time.Second).ExitCode())
		require.Equal(t, "in-done", s.stdout.String())
	}
}

// 入口没了（控制管道读到结束）：先给 CLI 发 SIGTERM 让它收尾，宽限期过了整组收掉，连不理 TERM 的也是。
func TestControlEndStopsCliThenKillsGroup(t *testing.T) {
	polite := start(t, "/bin/sh", "-c", `trap 'printf term; exit 0' TERM; while :; do sleep 0.02; done`)
	polite.childPid()
	require.NoError(t, polite.control.Close())
	polite.wait(3 * time.Second)
	require.Equal(t, "term", polite.stdout.String())

	stubborn := start(t, "/bin/sh", "-c", `trap '' TERM; sleep 30 & printf "%s\n" $!; wait`)
	child := stubborn.childPid()
	eventually(t, 3*time.Second, func() bool { return strings.Contains(stubborn.stdout.String(), "\n") }, "后台的 sleep 没起来")
	sleep, err := strconv.Atoi(strings.TrimSpace(stubborn.stdout.String()))
	require.NoError(t, err)
	began := time.Now()
	require.NoError(t, stubborn.control.Close())
	state := stubborn.wait(3 * time.Second)
	require.GreaterOrEqual(t, time.Since(began), grace, "要先等宽限期")
	require.Equal(t, syscall.SIGKILL, state.Sys().(syscall.WaitStatus).Signal())
	eventually(t, 2*time.Second, func() bool { return !alive(child) && !alive(sleep) }, "同组的进程没收掉")
}

// CLI 自己崩了：入口先让守护进程记下后台命令（s），守护进程按记下的身份补杀，不在本组的也杀得到。
// 后台命令不继承 CLI 的输出（CLI 的 Bash 工具也是这样）：守护进程和 node 的 close 一样要等输出读到结束。
func TestCliCrashKillsTrackedBackground(t *testing.T) {
	s := start(t, "/bin/sh", "-c", `set -m; sleep 300 >/dev/null 2>&1 & printf "%s\n" $!; wait`)
	child := s.childPid()
	eventually(t, 3*time.Second, func() bool { return strings.Contains(s.stdout.String(), "\n") }, "后台的 sleep 没起来")
	background, err := strconv.Atoi(strings.TrimSpace(s.stdout.String()))
	require.NoError(t, err)
	group, err := syscall.Getpgid(background)
	require.NoError(t, err)
	require.NotEqual(t, s.command.Process.Pid, group, "后台命令要在自己的进程组里")
	_, _ = s.control.Write([]byte("s"))
	time.Sleep(500 * time.Millisecond)
	require.NoError(t, syscall.Kill(child, syscall.SIGKILL))
	state := s.wait(3 * time.Second)
	require.Equal(t, 1, state.ExitCode(), "CLI 被信号结束时退出码是 1")
	eventually(t, 2*time.Second, func() bool { return !alive(background) }, "记下的后台命令没有补杀")
}

// 停止时同步记一次：没说过 s，入口没了也能收掉别组的后台命令。
func TestStopTracksBackgroundSynchronously(t *testing.T) {
	s := start(t, "/bin/sh", "-c", `set -m; trap '' TERM; sleep 300 >/dev/null 2>&1 & printf "%s\n" $!; wait`)
	s.childPid()
	eventually(t, 3*time.Second, func() bool { return strings.Contains(s.stdout.String(), "\n") }, "后台的 sleep 没起来")
	background, err := strconv.Atoi(strings.TrimSpace(s.stdout.String()))
	require.NoError(t, err)
	require.NoError(t, s.command.Process.Signal(syscall.SIGTERM))
	s.wait(3 * time.Second)
	eventually(t, 2*time.Second, func() bool { return !alive(background) }, "别组的后台命令没收掉")
}

func TestSpawnFailureAndMissingPipes(t *testing.T) {
	s := start(t, "/nonexistent/claude")
	require.Equal(t, 1, s.wait(3*time.Second).ExitCode())
	require.Contains(t, s.stderr.String(), "/nonexistent/claude")
	_, err := s.identity.ReadString('\n')
	require.ErrorIs(t, err, io.EOF, "没起来就不报进程号")

	bare := exec.Command(guardBinary, "/bin/sh", "-c", "exit 0")
	output, err := bare.CombinedOutput()
	require.Error(t, err)
	require.Contains(t, string(output), "文件描述符 3、4")
}
