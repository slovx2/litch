package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 设备进程的启动命令行是定死的接口（设计文档 04 第二节）：
//
//	<node> <root>/packages/device/dist/device/src/main.mjs \
//	  --listen unix://<home>/device/device.sock --state <home>/device \
//	  --process-buffer-bytes N --process-limit N --process-idle-ms N --process-exited-ms N \
//	  --upstream <harness>=unix://<home>/<harness>/runtime.sock …
//
// 中间那四个是属于设备的进程（可重连的终端）的上限和期限，取设置的现行值（settings_processes.go）。
// 之后设置再改，不重启设备进程，经控制通道把新值推给它。
func (d *deviceService) command(upstreams []configuration) *exec.Cmd {
	c := d.c
	args := []string{c.deviceMain(), "--listen", hostplatform.ListenURL(c.deviceSocket()), "--state", c.deviceDirectory()}
	args = append(args, c.processArguments()...)
	for _, upstream := range upstreams {
		// 原生 codex 不走启动参数：它是不是原生的只有控制通道说得清，设备进程从那里的名单知道它。
		if upstream.native() {
			continue
		}
		args = append(args, "--upstream", upstream.harness+"="+hostplatform.ListenURL(upstream.socket()))
	}
	process := exec.Command(c.node, args...)
	process.Env = c.serviceEnvironment()
	return process
}

// runOnce 跑一次设备进程，直到它退出或者 ctx 结束，返回前保证进程已经收掉。
// wasReady 表示它到过就绪；reason 是没能一直跑下去的原因分类。
func (d *deviceService) runOnce(ctx context.Context, upstreams []configuration, onReady func()) (wasReady bool, reason string, err error) {
	c := d.c
	// 只有拿着设备锁的进程可以清理遗留的套接字。
	if err := hostplatform.RemoveSocket(c.deviceSocket()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, "start-failed", err
	}
	defer hostplatform.RemoveSocket(c.deviceSocket())
	log, err := openPrivateLog(c.deviceDirectory(), "device.log")
	if err != nil {
		return false, "start-failed", err
	}
	defer log.Close()
	fmt.Fprintf(log, "\n[%s] 启动设备进程\n", time.Now().Format(time.RFC3339))
	// 标准输出自己读：要认就绪标记，其余原样进日志。不让 exec 代为转抄，进程一退出 Wait 就能返回。
	reader, writer, err := os.Pipe()
	if err != nil {
		return false, "start-failed", err
	}
	process := d.command(upstreams)
	process.Stdout, process.Stderr = writer, log
	hostplatform.Prepare(process)
	if err := process.Start(); err != nil {
		_ = writer.Close()
		_ = reader.Close()
		fmt.Fprintf(log, "设备进程启动失败: %v\n", err)
		return false, "start-failed", err
	}
	_ = writer.Close()
	ready, drained := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(drained)
		watchDeviceOutput(reader, log, ready)
	}()
	// 日志要等读输出的那一头停了才能关。
	defer func() { _ = reader.Close(); <-drained }()
	cleanup, err := hostplatform.Track(process)
	if err != nil {
		_ = hostplatform.Kill(process)
		_ = process.Wait()
		fmt.Fprintf(log, "无法管理设备进程: %v\n", err)
		return false, "start-failed", err
	}
	defer cleanup()
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = process.Wait(); close(done) }()
	defer func() {
		_ = hostplatform.Terminate(process)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = hostplatform.Kill(process)
			<-done
		}
	}()
	exited := func() error {
		if waitErr != nil {
			return waitErr
		}
		return errors.New("exit status 0")
	}
	timeout := time.NewTimer(deviceReadyTimeout)
	defer timeout.Stop()
	select {
	case <-ctx.Done():
		return false, "", ctx.Err()
	case <-done:
		fmt.Fprintf(log, "设备进程没有就绪就退出了: %v\n", exited())
		return false, "exited", exited()
	case <-timeout.C:
		fmt.Fprintf(log, "设备进程 %s 内没有就绪\n", deviceReadyTimeout)
		return false, "ready-timeout", context.DeadlineExceeded
	case <-ready:
	}
	onReady()
	select {
	case <-ctx.Done():
		return true, "", ctx.Err()
	case <-done:
		fmt.Fprintf(log, "设备进程已退出: %v\n", exited())
		return true, "exited", exited()
	}
}

// 把设备进程的标准输出逐行抄进日志，见到就绪标记时通知一次。一直读到对面关闭。
// 行再长也不能停下不读，不然设备进程会堵在写标准输出上。
func watchDeviceOutput(source io.Reader, log io.Writer, ready chan<- struct{}) {
	reader := bufio.NewReaderSize(source, 64*1024)
	announced, continued := false, false
	for {
		line, partial, err := reader.ReadLine()
		if err != nil {
			return
		}
		_, _ = log.Write(line)
		if !partial {
			_, _ = log.Write([]byte{'\n'})
		}
		if !announced && !continued && !partial && strings.TrimSpace(string(line)) == deviceReadyMarker {
			announced = true
			close(ready)
		}
		continued = partial
	}
}
