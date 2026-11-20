package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 显式指定隔离的前台夹具才登记系统服务。夹具接收 start 的参数，并将 PID 写到状态目录。
func TestAutostartNativeManager(t *testing.T) {
	binary := os.Getenv("LITCH_TEST_AUTOSTART_FOREGROUND")
	if binary == "" {
		t.Skip("需指定独立前台夹具 LITCH_TEST_AUTOSTART_FOREGROUND")
	}
	home := t.TempDir()
	root := filepath.Join(home, "root path")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	h, err := newAutostartHost(configuration{home: home})
	if err != nil || h.backend == nil {
		t.Fatalf("用户服务管理器: %v", err)
	}
	b := h.backend
	s := h.spec
	s.Executable, s.Root, s.Node = binary, root, binary
	if err := s.validate(); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	t.Logf("临时服务标识 %s", s.ID)
	before := b.inspect(ctx, s)
	if before.registered || before.repair != nil {
		t.Fatalf("临时服务名不可用: %+v, repair=%+v", before, before.repair)
	}
	// 即使安装过程报错也再次查询归属并清理，避免留下临时登记。
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		state := b.inspect(ctx, s, s)
		if state.registered && !state.foreign {
			if err := b.remove(ctx, s, state); err != nil {
				t.Errorf("清理服务 %s: %v", s.ID, err)
			}
		}
	})
	start := func() autostartManagerState {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		for {
			state := b.inspect(ctx, s, s)
			if state.running && state.exact && state.enabled && state.repair == nil {
				return state
			}
			if err := pause(ctx, deadline, 350*time.Millisecond); err != nil {
				t.Fatalf("未观察到正确登记并运行的服务: %+v, repair=%+v", state, state.repair)
			}
		}
	}
	if err := b.install(ctx, s, before); err != nil {
		t.Fatal(err)
	}
	state := start()
	pidFile := filepath.Join(s.Home, "fixture.pid")
	waitPID := func(old int, timeout time.Duration) int {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for {
			raw, _ := os.ReadFile(pidFile)
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 && pid != old {
				return pid
			}
			if err := pause(ctx, deadline, 500*time.Millisecond); err != nil {
				t.Fatalf("监督器没有启动前台夹具，前一进程号 %d", old)
			}
		}
	}
	process := waitPID(0, 10*time.Second)
	t.Logf("登记和实际前台 PID %d 已核对", process)
	if state.pid != 0 && state.pid != process {
		t.Fatalf("管理器 PID %d 与实际进程 %d 不同", state.pid, process)
	}
	if err := b.install(ctx, s, state); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("LITCH_TEST_AUTOSTART_CRASH") == "1" {
		proc, err := os.FindProcess(process)
		if err != nil {
			t.Fatal(err)
		}
		if err := proc.Kill(); err != nil {
			t.Fatal(err)
		}
		next := waitPID(process, 100*time.Second)
		state = start()
		if state.pid != 0 && state.pid != next {
			t.Fatalf("重启后管理器进程不匹配: %d != %d", state.pid, next)
		}
		t.Logf("监督器在进程故障后另起 PID %d", next)
	}
	if err := os.Mkdir(filepath.Join(s.Home, "device"), 0o700); err != nil {
		t.Fatal(err)
	}
	const revision = 42
	t.Cleanup(func() { b.cleanupWorker(context.Background(), s, revision) })
	if err := b.enqueue(ctx, s, revision); err != nil {
		t.Fatal(err)
	}
	workerDeadline := time.Now().Add(15 * time.Second)
	for {
		data, err := os.ReadFile(filepath.Join(s.Home, "fixture.worker"))
		if err == nil && strings.TrimSpace(string(data)) == strconv.Itoa(revision) {
			t.Log("系统管理器已独立启动变更助手")
			break
		}
		if err := pause(ctx, workerDeadline, 250*time.Millisecond); err != nil {
			t.Fatalf("未观察到独立助手启动: %v", err)
		}
	}
	if err := b.remove(ctx, s, state); err != nil {
		t.Fatal(err)
	}
	after := b.inspect(ctx, s, s)
	if after.registered || after.running || after.enabled || after.repair != nil {
		t.Fatalf("卸载后仍可见或无法验证: %+v, repair=%+v", after, after.repair)
	}
	if runtime.GOOS == "linux" && after.linger != before.linger {
		t.Fatalf("卸载动了 linger：%s → %s", before.linger, after.linger)
	}
	if _, err := os.Stat(pidFile); err != nil {
		t.Fatalf("卸载删除了状态文件: %v", err)
	}
	t.Log("已卸载并核验状态文件保留")
}
