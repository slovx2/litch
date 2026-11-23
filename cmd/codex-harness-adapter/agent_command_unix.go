//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func execAgentHost(binary string, args, env []string) error { return syscall.Exec(binary, args, env) }

func keepAgentSlot(command *exec.Cmd, slot *os.File) {
	// 包装进程被 OOM 强杀时，仍存活的 Node 会继续占着席位。
	command.ExtraFiles = []*os.File{slot}
}
