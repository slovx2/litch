//go:build darwin

package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 子测试进程只拥有自己的租约；父测试强杀它，验证 -w 的非正常退出收尾。
func TestPowerSystemOwnerHelper(t *testing.T) {
	if os.Getenv("LITCH_TEST_POWER_OWNER_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	lease, err := (systemPowerBackend{}).start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lease.stop()
	fmt.Println(lease.(*caffeinateLease).process.Pid)
	time.Sleep(time.Minute)
}

func TestPowerSystemOwnerKilled(t *testing.T) {
	if os.Getenv("LITCH_TEST_POWER_SYSTEM") != "1" {
		t.Skip("set LITCH_TEST_POWER_SYSTEM=1 for the real macOS assertion check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPowerSystemOwnerHelper$")
	command.Env = append(os.Environ(), "LITCH_TEST_POWER_OWNER_HELPER=1")
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = command.Wait(); close(done) }()
	t.Cleanup(func() { _ = command.Process.Kill(); <-done })
	reader := bufio.NewReader(output)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("helper 没有返回租约 PID: %q", line)
	}
	marker := "pid " + strconv.Itoa(pid) + "(caffeinate)"
	assertions, err := exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "assertions").Output()
	if err != nil || !strings.Contains(string(assertions), marker) {
		t.Fatalf("父进程存活时没有租约断言: %d %v", pid, err)
	}
	if err = command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-done
	for {
		assertions, err = exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "assertions").Output()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(assertions), marker) {
			t.Logf("Go owner 被 SIGKILL 后 caffeinate %d 的断言已释放", pid)
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("owner 退出后断言未释放")
		case <-time.After(50 * time.Millisecond):
		}
	}
}
