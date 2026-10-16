package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/slovx2/litch/internal/hostplatform"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

func serve(ctx context.Context, c configuration) error {
	return serveRuntime(ctx, c, false, nil, nil)
}

// 常驻服务管着运行时的时候挂上来的：运行时就绪了要知道，SSH 入口要跟着设置变。
// 单独 serve 一个入口时没有，为 nil，SSH 入口照启动参数来、一直不变。
type runtimeHooks struct {
	running func()
	// SSH 入口现行的设置。
	ssh func() (enabled bool, port int)
	// 设置变了，回头再看一眼 ssh。
	sshWake <-chan struct{}
}

func plainFailure(text bilingual) error {
	return &harnessFailure{kind: stateStartFailed, text: text, err: errors.New(text.String())}
}

// 检查环境，备好起运行时的命令行（还没有起）。version 是 SSH 入口报给桌面端的版本，原生 codex 没有入口，为空。
func prepareRuntime(ctx context.Context, c configuration) (process *exec.Cmd, version string, err error) {
	if c.native() {
		// 上一次的服务被强杀时留下的 app-server 先收掉，不然新的起不来（native_codex_unix.go）
		reapCodexOrphan(c)
		path, _, err := inspectCodex(ctx, c)
		if err != nil {
			return nil, "", err
		}
		return codexCommand(c, path), "", nil
	}
	info, err := inspectRuntime(ctx, c)
	if err != nil {
		return nil, "", err
	}
	process = exec.Command(c.node, c.adapter(), "app-server", "--listen", hostplatform.ListenURL(c.socket()))
	process.Env = c.environment()
	return process, info.ProtocolVersion + " (codex-harness-adapter-" + c.harness + ")", nil
}

// 一个入口分两段：先是运行时（只用本机套接字），然后才是给 Codex 桌面端的 SSH 入口。
// 后一段是可选件，关着或者起不来都不影响前一段。stage 是 start 用来排次序的，单独 serve 时为 nil。
func serveRuntime(ctx context.Context, c configuration, autoInit bool, stage *startStage, hooks *runtimeHooks) error {
	runtimeUp := false
	defer func() {
		if !runtimeUp {
			stage.settle(c.harness, false)
		}
	}()
	if c.harness == "" {
		return errors.New(tr("必须指定 --harness", "--harness is required"))
	}
	if runtime.GOOS != "windows" && len(c.socket()) > 100 {
		return plainFailure(both("状态路径过长，无法创建 Unix socket；请使用较短的 --home", "the state path is too long for a Unix socket; use a shorter --home"))
	}
	if err := os.MkdirAll(c.directory(), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(c.directory(), "serve.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := hostplatform.Lock(lock); err != nil {
		return plainFailure(both("此 harness 状态目录已有运行进程", "another process is already running on this harness's state directory"))
	}
	defer hostplatform.Unlock(lock)
	process, version, err := prepareRuntime(ctx, c)
	if err != nil {
		return err
	}
	if autoInit {
		fmt.Printf(tr("[%s] 检测通过，正在初始化并启动…\n", "[%s] Check passed; initialising and starting…\n"), c.harness)
	}
	// 仅持有状态锁的进程可以清理本入口遗留的 socket。
	if err := hostplatform.RemoveSocket(c.socket()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	defer hostplatform.RemoveSocket(c.socket())
	log, err := openLocalLog(c, "runtime.log")
	if err != nil {
		return err
	}
	defer log.Close()
	process.Stdout, process.Stderr = log, log
	runtimeFailure := func(kind string, message bilingual, cause error) error {
		fmt.Fprintf(log, "\n%s: %v\n", message, cause)
		logPath := filepath.Join(c.directory(), "runtime.log")
		return &harnessFailure{kind: kind, text: message, logPath: logPath,
			err: fmt.Errorf(tr("%s，请重试；若仍失败，请查看日志 %s", "%s. Please retry; if it keeps failing, see the log %s"), message, logPath)}
	}
	startFailure := both("引擎启动失败", "The engine failed to start")
	stopped := both("引擎已停止", "The engine has stopped")
	hostplatform.Prepare(process)
	if err := process.Start(); err != nil {
		return runtimeFailure(stateStartFailed, startFailure, err)
	}
	if c.native() {
		// 记下它的进程号，正常收掉之后再抹掉；抹不掉（本进程被强杀）的，下次起之前按它去收
		recordCodexProcess(c, process.Process.Pid)
		defer forgetCodexProcess(c)
	}
	cleanup, err := hostplatform.Track(process)
	if err != nil {
		_ = hostplatform.Kill(process)
		_ = process.Wait()
		return runtimeFailure(stateStartFailed, both("无法管理引擎进程", "Cannot manage the engine process"), err)
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
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	ready := false
	for !ready {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return runtimeFailure(stateStartFailed, startFailure, waitErr)
		case <-deadline.C:
			return runtimeFailure(stateStartFailed, both("引擎启动超时", "The engine timed out while starting"), context.DeadlineExceeded)
		case <-ticker.C:
			connection, err := hostplatform.Dial(c.socket())
			if err == nil {
				_ = connection.Close()
				ready = true
			}
		}
	}
	runtimeUp = true
	stage.settle(c.harness, true)
	if hooks != nil {
		hooks.running()
	}
	// 原生 codex 没有 SSH 入口，到这里就只剩等它停。
	if hasSSHEntry(c.harness) {
		// 聚合面排在 SSH 入口前面：等设备进程那一步有了结果（就绪、没起来或跳过）再往下走。
		select {
		case <-ctx.Done():
			return nil
		case <-done:
			return runtimeFailure(stateStopped, stopped, waitErr)
		case <-stage.released():
		}
		// 先收 SSH 入口，再停运行时。
		defer runSSHEntry(ctx, c, version, autoInit, done, log, hooks)()
	}
	select {
	case <-ctx.Done():
		return nil
	case <-done:
		return runtimeFailure(stateStopped, stopped, waitErr)
	}
}
