//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	// Windows 上没有进程组可杀，停止时用 taskkill 收掉 CLI 的整棵进程树
	stopKillsGroup = false
	// 没有 ps，不记后台命令
	tracksBackground = false
)

// 和 windows.StartupInfo 同样的布局，只是把 lpReserved2 那两项露出来。
type startupInfo struct {
	Cb            uint32
	_             *uint16
	Desktop       *uint16
	Title         *uint16
	X             uint32
	Y             uint32
	XSize         uint32
	YSize         uint32
	XCountChars   uint32
	YCountChars   uint32
	FillAttribute uint32
	Flags         uint32
	ShowWindow    uint16
	CbReserved2   uint16
	LpReserved2   *byte
	StdInput      windows.Handle
	StdOutput     windows.Handle
	StdErr        windows.Handle
}

// node（libuv）在 Windows 上把 3 号以后的管道按 C 运行库的约定放在 STARTUPINFO 的 lpReserved2 里传过来，
// 不是 Go 认的文件描述符，要自己取出句柄。
func inheritedFile(fd int, name string) *os.File {
	var info startupInfo
	if windows.GetStartupInfo((*windows.StartupInfo)(unsafe.Pointer(&info))) != nil {
		return nil
	}
	if info.LpReserved2 == nil || info.CbReserved2 == 0 {
		return nil
	}
	handle, ok := crtHandle(unsafe.Slice(info.LpReserved2, info.CbReserved2), fd, int(unsafe.Sizeof(uintptr(0))))
	if !ok {
		return nil
	}
	return os.NewFile(handle, name)
}

func watchSignals(stop func()) {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		for range signals {
			stop()
		}
	}()
}

func (g *guard) stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopping {
		return
	}
	g.stopping = true
	if g.closed || g.child == nil {
		return
	}
	pid := g.child.Process.Pid
	go func() {
		err := exec.Command("taskkill", "/pid", strconv.Itoa(pid), "/t", "/f").Run()
		var exited *exec.ExitError
		if err != nil && !errors.As(err, &exited) {
			fmt.Fprint(os.Stderr, err.Error())
		}
	}()
}

func (g *guard) finish() {}

func killTree(row) {}
