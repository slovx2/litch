package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
)

// 启动次序：各运行时 → 设备进程（聚合面）→ SSH 入口。前两步只用本机套接字，SSH 入口是可选件。
func start(ctx context.Context, c configuration) error {
	if c.sshDisabled {
		fmt.Println(tr(
			"启动本地适配器；给 Codex 桌面端的 SSH 入口已关闭（--ssh=off），不占用端口。",
			"Starting the local adapter. The SSH entries for the Codex desktop app are off (--ssh=off); no port is taken.",
		))
	} else {
		fmt.Println(tr(
			"启动本地适配器；Codex 设置 → 连接 → SSH → 添加，可手动填写下方参数，也可将 Host 配置加入 ~/.ssh/config（Windows: %USERPROFILE%\\.ssh\\config）后选择别名。",
			"Starting the local adapter. In Codex: Settings → Connections → SSH → Add. Enter the parameters below by hand, or add the Host block to ~/.ssh/config (Windows: %USERPROFILE%\\.ssh\\config) and pick the alias.",
		))
	}
	fmt.Println(tr(
		"自动检测 Claude Code 和 Pi；缺失或启动失败的入口只告警，其他入口继续运行。只使用一个引擎可加 --harness claude-code 或 --harness pi。",
		"Claude Code and Pi are detected automatically. An entry that is missing or fails to start only produces a warning; the others keep running. To use one engine only, add --harness claude-code or --harness pi.",
	))
	if c.settings == nil {
		settings, err := loadSettings(c.home)
		if err != nil {
			return err
		}
		c.settings = settings
	}
	// 服务除了被信号中断，还可以被请着自己停（device-stop 经控制通道来的 service.stop）：两条路收场的次序一样。
	ctx, shutdown := context.WithCancel(ctx)
	defer shutdown()
	// 每个已知的 harness 一个位置，不管这次起不起：没起的原因要报给客户端，以后也可能在设置里被启用。
	manager := newHarnessManager(c)
	entries := manager.entries()
	stage := newStartStage(entries)
	manager.stage = stage
	device := openDeviceService(c)
	manager.aggregate = device.provides()
	deviceContext, stopDevice := context.WithCancel(ctx)
	control := device.openControl(deviceContext, manager, shutdown)
	deviceStopped := make(chan struct{})
	go func() {
		defer close(deviceStopped)
		device.run(deviceContext, stage)
	}()
	err := supervise(ctx, entries, func(ctx context.Context, entry configuration) error {
		return manager.run(ctx, entry.harness)
	})
	// 入口全部结束（被中断、被请停，或者一个都不剩、聚合面也给不出来）后，设备进程和控制通道一并收掉，最后才放设备锁。
	stopDevice()
	<-deviceStopped
	control.close()
	device.release()
	return err
}

// startStage 记着一次 start 的进度：哪些运行时起来了，SSH 入口能不能开始。
// 方法都接受 nil：单独 serve 一个入口时没有设备进程，也就没有要等的东西。
type startStage struct {
	mu       sync.Mutex
	entries  []configuration
	outcome  map[string]bool // 已有结果的运行时；true 表示起来了
	settled  chan struct{}   // 全部运行时都有了结果
	gate     chan struct{}   // SSH 入口可以启动了
	gateOnce sync.Once
}

var openGate = func() chan struct{} {
	gate := make(chan struct{})
	close(gate)
	return gate
}()

func newStartStage(entries []configuration) *startStage {
	return &startStage{entries: entries, outcome: map[string]bool{}, settled: make(chan struct{}), gate: make(chan struct{})}
}

func (s *startStage) settle(harness string, up bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, known := s.outcome[harness]; known {
		return
	}
	s.outcome[harness] = up
	if len(s.outcome) == len(s.entries) {
		close(s.settled)
	}
}

// 设备进程启动时要接的运行时，按入口的顺序：起来了的，加上到这时还没有结果的（设备进程容许上游晚一点才连得上）。
// 已经确定没起来的（没装、检查不过、停用着）不在里面，它们以后起来了由控制通道告诉设备进程。
// 正常情况下调用时全部都有结果了。
func (s *startStage) upstreams() []configuration {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []configuration{}
	for _, entry := range s.entries {
		if up, known := s.outcome[entry.harness]; up || !known {
			result = append(result, entry)
		}
	}
	return result
}

func (s *startStage) release() {
	if s != nil {
		s.gateOnce.Do(func() { close(s.gate) })
	}
}

func (s *startStage) released() <-chan struct{} {
	if s == nil {
		return openGate
	}
	return s.gate
}

func warnEntryFailure(err error) {
	fmt.Fprintf(os.Stderr, tr("警告：%v；此入口未运行，其他可用入口不受影响。\n", "Warning: %v; this entry is not running, other available entries are unaffected.\n"), err)
}

// 入口独立运行；失败只告警，退出时仍等待所有已启动服务清理完成。
func supervise(ctx context.Context, entries []configuration, launch func(context.Context, configuration) error) error {
	group, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, len(entries))
	for _, entry := range entries {
		go func() {
			err := launch(group, entry)
			if err != nil {
				err = fmt.Errorf("%s: %w", entry.harness, err)
			}
			results <- err
		}()
	}
	var failures []error
	for range entries {
		err := <-results
		if err != nil && !errors.Is(err, context.Canceled) {
			// 常驻服务里的入口失败当时就告过警了，这里只汇总。
			var reported *reportedFailure
			if !errors.As(err, &reported) {
				warnEntryFailure(err)
			}
			failures = append(failures, err)
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	return errors.Join(append([]error{errors.New(both("没有可用的适配器入口。请检查上方原因，安装所需 CLI 或运行 %s", "No adapter entry is available. Check the reasons above, install the required CLI, or run %s").pair(doctorCommand).String())}, failures...)...)
}
