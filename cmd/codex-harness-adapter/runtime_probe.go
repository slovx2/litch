package main

import (
	"context"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 版本、npm 前缀和运行时诊断共享预算。等待席位算在各调用自己的超时里。
const runtimeProbeConcurrency = 4

var runtimeProbeSlots = make(chan struct{}, runtimeProbeConcurrency)

func runRuntimeProbe(ctx context.Context, command *exec.Cmd) error {
	select {
	case runtimeProbeSlots <- struct{}{}:
		defer func() { <-runtimeProbeSlots }()
	case <-ctx.Done():
		return ctx.Err()
	}
	return runBoundedChild(command)
}

// 用进程组或 Job 收掉包装程序下面的进程。超时必须回收之后，调用方才能归还席位。
func runBoundedChild(command *exec.Cmd) error {
	hostplatform.Prepare(command)
	var mu sync.Mutex
	var clean func()
	command.Cancel = func() error {
		mu.Lock()
		defer mu.Unlock()
		if clean != nil {
			clean()
			clean = nil
			return command.Process.Kill()
		}
		return hostplatform.Kill(command)
	}
	command.WaitDelay = time.Second
	// Cancel 可能在 Start 返回前已就绪，先锁住直到子进程归入 Job。
	mu.Lock()
	if err := command.Start(); err != nil {
		mu.Unlock()
		return err
	}
	if runtime.GOOS == "windows" {
		if closeJob, err := hostplatform.Track(command); err == nil {
			clean = closeJob
		}
	}
	mu.Unlock()
	err := command.Wait()
	mu.Lock()
	defer mu.Unlock()
	if clean != nil {
		clean()
	}
	return err
}
