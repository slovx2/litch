package main

import (
	"os"
	"os/exec"
)

// Windows 在同一个并发入口内运行宿主命令，没有 exec(2)。
func execAgentHost(_ string, _, _ []string) error { panic("exec unsupported on Windows") }

func keepAgentSlot(_ *exec.Cmd, _ *os.File) {}
