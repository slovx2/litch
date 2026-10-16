//go:build !windows

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// 伪终端桥的用例都把它当成真的进程来跑：用测试程序自己顶替命令行（TestMain 里的 testCLIEnvironment），
// 走的是 main 里分发 pty-bridge 的那条路，标准输入输出、信号、退出码都是真的。

// 一次运行着的桥，连同它到现在为止写出来的东西。
type ptyBridgeSession struct {
	t       *testing.T
	command *exec.Cmd
	stdin   io.WriteCloser
	stdout  *os.File
	started time.Time

	mu      sync.Mutex
	lines   int              // 一共读到几行
	first   map[string]any   // 第一行，握手
	others  []map[string]any // 握手之后不是输出的行，正常情况下一条都没有
	output  []byte           // 终端上的输出，按到达的次序接起来
	largest int              // 最大的一条输出有多少字节
	changed chan struct{}    // 每读到一行通知一次
	drained chan struct{}    // 标准输出读到头了

	exited chan struct{}
	code   int
}

// 起一份桥。environment 是在测试进程的环境之外再加（或者盖掉）的；directory 为空就用测试进程的工作目录。
func startPtyBridge(t *testing.T, environment []string, directory string, args ...string) *ptyBridgeSession {
	t.Helper()
	// 用绝对路径：有的用例给桥换了工作目录。
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, append([]string{"pty-bridge"}, args...)...)
	command.Env = append(append(os.Environ(), testCLIEnvironment+"=1"), environment...)
	command.Dir = directory
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	// 输出的管道自己建：有的用例要抢在桥之前把读的这一头关掉。
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stdout = writer
	session := &ptyBridgeSession{
		t: t, command: command, stdin: stdin, stdout: reader, started: time.Now(),
		changed: make(chan struct{}, 1), drained: make(chan struct{}), exited: make(chan struct{}),
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	go session.read()
	go func() {
		err := command.Wait()
		session.code = command.ProcessState.ExitCode()
		if err != nil && session.code == 0 {
			session.code = -1
		}
		close(session.exited)
	}()
	t.Cleanup(func() {
		// 用例不管成没成，桥和它起的那一组进程都不留。
		_ = command.Process.Kill()
		if pid := session.spawnedPID(); pid > 0 {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
		<-session.exited
		_ = reader.Close()
	})
	return session
}

// 起一份跑 shell 脚本的桥，默认的终端大小。
func startPtyScript(t *testing.T, script string) *ptyBridgeSession {
	t.Helper()
	return startPtyBridge(t, nil, "", "--", "/bin/sh", "-c", script)
}

func (s *ptyBridgeSession) read() {
	defer close(s.drained)
	reader := bufio.NewReaderSize(s.stdout, 1<<16)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			// 桥不该留下半行。
			if len(line) > 0 {
				s.record(map[string]any{"半行": string(line)}, nil)
			}
			return
		}
		var message map[string]any
		if json.Unmarshal(line, &message) != nil {
			s.record(map[string]any{"不是 JSON": string(line)}, nil)
			continue
		}
		var data []byte
		if message["stream"] == "stdout" {
			text, _ := message["delta"].(string)
			if data, err = base64.StdEncoding.DecodeString(text); err != nil || len(data) == 0 {
				s.record(map[string]any{"坏的输出": string(line)}, nil)
				continue
			}
		}
		s.record(message, data)
	}
}

func (s *ptyBridgeSession) record(message map[string]any, data []byte) {
	s.mu.Lock()
	s.lines++
	switch {
	case s.lines == 1:
		s.first = message
	case data != nil:
		s.output = append(s.output, data...)
		s.largest = max(s.largest, len(data))
	default:
		s.others = append(s.others, message)
	}
	s.mu.Unlock()
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

// 等到条件成立。条件在锁里看；到点还不成立、或者桥的输出已经到头而条件仍不成立，返回 false。
func (s *ptyBridgeSession) until(limit time.Duration, condition func() bool) bool {
	deadline := time.After(limit)
	for {
		s.mu.Lock()
		met := condition()
		s.mu.Unlock()
		if met {
			return true
		}
		select {
		case <-s.changed:
		case <-s.drained:
			s.mu.Lock()
			defer s.mu.Unlock()
			return condition()
		case <-deadline:
			return false
		}
	}
}

// 握手的那一行；没等到就让用例失败。
func (s *ptyBridgeSession) handshake() map[string]any {
	s.t.Helper()
	if !s.until(10*time.Second, func() bool { return s.first != nil }) {
		s.t.Fatal("没有等到桥的第一行")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.first
}

// 握手报的进程号，也是进程组号；启动失败时让用例失败。
func (s *ptyBridgeSession) pid() int {
	s.t.Helper()
	first := s.handshake()
	pid, _ := first["pid"].(float64)
	if first["event"] != "spawned" || pid <= 0 {
		s.t.Fatalf("桥没有报启动成功: %v", first)
	}
	return int(pid)
}

func (s *ptyBridgeSession) spawnedPID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	pid, _ := s.first["pid"].(float64)
	return int(pid)
}

var ptyNewlines = regexp.MustCompile(`\r+\n`)

// 到现在为止的输出。行尾归一成 \n：终端会把 \n 写成 \r\n，macOS 上读得慢时还会多出 \r。
func (s *ptyBridgeSession) text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ptyNewlines.ReplaceAllString(string(s.output), "\n")
}

// 等输出里出现这段字。
func (s *ptyBridgeSession) expect(fragment string) {
	s.t.Helper()
	found := func() bool {
		return strings.Contains(ptyNewlines.ReplaceAllString(string(s.output), "\n"), fragment)
	}
	if !s.until(10*time.Second, found) {
		s.t.Fatalf("输出里没有等到 %q，现在是 %q", fragment, s.text())
	}
}

func (s *ptyBridgeSession) send(message map[string]any) {
	s.t.Helper()
	line, _ := json.Marshal(message)
	if _, err := s.stdin.Write(append(line, '\n')); err != nil {
		s.t.Fatalf("指令没有写进去: %v", err)
	}
}

func (s *ptyBridgeSession) input(text string) {
	s.t.Helper()
	s.send(map[string]any{"action": "input", "data": base64.StdEncoding.EncodeToString([]byte(text))})
}

// 等桥退出并把它写的东西读完，返回退出码和从启动算起用了多久。握手之外有不认识的行就让用例失败。
func (s *ptyBridgeSession) exit(limit time.Duration) (int, time.Duration) {
	s.t.Helper()
	select {
	case <-s.exited:
	case <-time.After(limit):
		s.t.Fatalf("桥过了 %v 还没有退出，输出是 %q", limit, s.text())
	}
	elapsed := time.Since(s.started)
	select {
	case <-s.drained:
	case <-time.After(5 * time.Second):
		s.t.Fatal("桥退出了，它的标准输出却没有到头")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.others) > 0 {
		s.t.Fatalf("桥写了不认识的行: %v", s.others)
	}
	return s.code, elapsed
}

// 等这个进程组里一个进程都不剩。被杀的进程要等有人收走才算没了，所以给它一点时间。
func expectPtyGroupGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := syscall.Kill(-pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			t.Fatalf("进程组 %d 里还有进程（探测的结果是 %v）", pid, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
