//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

type systemPowerBackend struct{}

func (systemPowerBackend) supported() bool { return true }

func caffeinateArguments(pid int) []string {
	return []string{"-i", "-w", strconv.Itoa(pid), "-t", "120"}
}

func (systemPowerBackend) start(ctx context.Context) (powerLease, error) {
	command := exec.Command("/usr/bin/caffeinate", caffeinateArguments(os.Getpid())...)
	command.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	if err := command.Start(); err != nil {
		return nil, err
	}
	lease := &caffeinateLease{process: command.Process, done: make(chan struct{})}
	go func() { lease.err = command.Wait(); close(lease.done) }()
	// Start 成功不等于程序接受了参数；尽早退出必须报告失败。
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-lease.done:
		return nil, fmt.Errorf("caffeinate exited during startup: %v", lease.err)
	case <-ctx.Done():
		lease.stop()
		return nil, ctx.Err()
	case <-timer.C:
		return lease, nil
	}
}

func (systemPowerBackend) source(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "batt")
	command.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	output, err := command.Output()
	if err != nil {
		return "unknown", err
	}
	source := parsePowerSource(string(output))
	if source == "unknown" {
		return source, errors.New("pmset did not report a recognized power source")
	}
	return source, nil
}

type caffeinateLease struct {
	process *os.Process
	done    chan struct{}
	err     error
}

func (p *caffeinateLease) exited() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}
func (p *caffeinateLease) stop() {
	if !p.exited() {
		_ = p.process.Kill()
	}
	// 子进程有 Wait 的唯一收尾方，正常退出不会留下僵尸。
	<-p.done
}
