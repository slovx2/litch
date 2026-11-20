package main

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func main() {
	// 旁路验证助手确实经系统启动；不运行真正的适配器或 harness。
	if len(os.Args) == 4 && os.Args[1] == "device-autostart-worker" {
		if err := os.WriteFile(filepath.Join(os.Args[2], "fixture.worker"), []byte(os.Args[3]), 0o600); err != nil {
			os.Exit(4)
		}
		return
	}
	if len(os.Args) < 5 || os.Args[1] != "start" || os.Args[3] != "--home" {
		os.Exit(2)
	}
	if err := os.WriteFile(filepath.Join(os.Args[4], "fixture.pid"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		os.Exit(3)
	}
	for {
		time.Sleep(time.Second)
	}
}
