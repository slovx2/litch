package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 设备进程（Node，packages/device）把各运行时收在一个聚合面后面，给我们自己的客户端连。
// 这里只管把它拉起来、看着它、停掉它。它对各运行时来说只是又一个客户端，起不来不影响任何入口。
//
// <home>/device/ 里由这一层写的文件：
//   serve.lock    设备锁。start 一开始就拿住，谁拿着谁管这个状态目录的聚合面
//   settings.json 设备的设置（settings.go）。只有写过设置才有
//   ctl.sock      和设备进程之间的控制通道（control.go），服务在跑时才有
//   service.json  常驻服务报的聚合面状况，只在设备锁被拿着时可信
//   device.log    设备进程的输出
//   start.lock    device-start 排队用的锁
//   service.log   device-start 拉起的常驻服务的输出
// device.sock（聚合面）和 device.sqlite 归设备进程自己。

// 设备进程就绪后在标准输出打的那一行。
const deviceReadyMarker = "LITCH_DEVICE_READY"

var (
	deviceReadyTimeout = 30 * time.Second
	deviceRestartDelay = time.Second
	deviceRestartLimit = 30 * time.Second
	// 就绪后撑过这么久才算稳定，下次退出时重试间隔从头算。
	deviceStableAfter = 30 * time.Second
	// 等各运行时有结果最多等这么久。某一个卡在环境检查上时，不能让其余入口的聚合面和 SSH 跟着干等。
	deviceSettleWait = 10 * time.Second
)

func (c configuration) deviceDirectory() string { return filepath.Join(c.home, "device") }
func (c configuration) deviceSocket() string {
	return hostplatform.DeviceSocketPath(c.deviceDirectory())
}
func (c configuration) deviceMain() string {
	return filepath.Join(c.root, "packages", "device", "dist", "device", "src", "main.mjs")
}
func (c configuration) deviceLog() string { return filepath.Join(c.deviceDirectory(), "device.log") }
func (c configuration) serviceStatusPath() string {
	return filepath.Join(c.deviceDirectory(), "service.json")
}

// 设备进程不属于任何一个 harness：带启动进程的环境和环境文件里的值，不带各入口自己的固定变量。
// 只有命令行自己的路径是定死的（属于设备的终端要用它的 pty-bridge 子命令），别处给的同名变量不算数。
func (c configuration) serviceEnvironment() []string {
	result := []string{}
	present := map[string]bool{adapterCLIEnvironment: true}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if name == adapterCLIEnvironment {
			continue
		}
		present[name] = true
		result = append(result, entry)
	}
	for name, value := range c.userEnv {
		if !present[name] {
			result = append(result, name+"="+value)
		}
	}
	if path := adapterCLIPath(); path != "" {
		result = append(result, adapterCLIEnvironment+"="+path)
	}
	return result
}

type serviceStatus struct {
	PID       int    `json:"pid"`              // 常驻的 start 进程
	State     string `json:"state"`            // starting、ready、retrying、unavailable
	Reason    string `json:"reason,omitempty"` // artifact-missing、path-too-long、start-failed、ready-timeout、exited
	Detail    string `json:"detail,omitempty"`
	Socket    string `json:"socket"`
	UpdatedAt string `json:"updatedAt"`
	// 这份服务的来历（service_facts.go）。这次改动之前的服务不写这一项，读出来是 nil。
	Service *serviceFacts `json:"service,omitempty"`
}

func readServiceStatus(c configuration) (serviceStatus, bool) {
	var status serviceStatus
	data, err := os.ReadFile(c.serviceStatusPath())
	if err != nil || json.Unmarshal(data, &status) != nil {
		return status, false
	}
	return status, true
}

// 取状态锁。device-start 探测锁有没有人拿着时会短暂占住它，所以多试几次，免得正好被探测挡掉。
func lockWithRetry(file *os.File) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = hostplatform.Lock(file); err == nil {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return err
}

type deviceService struct {
	c    configuration
	lock *os.File // nil：这个状态目录的聚合面不归本进程管
	// 这份服务的来历，启动时定下来。
	facts *serviceFacts
}

// start 一开始就调用：先把设备锁拿住，后来的 device-start 才知道这里已经有服务在起。
func openDeviceService(c configuration) *deviceService {
	service := &deviceService{c: c, facts: describeService(c)}
	directory := c.deviceDirectory()
	err := os.MkdirAll(directory, 0o700)
	if err == nil {
		// 聚合面的套接字只有属主能碰，目录先收紧。
		_ = os.Chmod(directory, 0o700)
		err = hostplatform.Protect(directory)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, tr("警告：无法准备设备服务的状态目录 %s: %v；聚合面未启动，各入口不受影响。\n", "Warning: cannot prepare the device service's state directory %s: %v; the aggregate endpoint is not started, entries are unaffected.\n"), directory, err)
		return service
	}
	lock, err := os.OpenFile(filepath.Join(directory, "serve.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err == nil {
		if err = lockWithRetry(lock); err != nil {
			_ = lock.Close()
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, tr(
			"警告：这个状态目录的聚合面由另一个适配器进程提供，本次启动的入口不在其中。",
			"Warning: the aggregate endpoint of this state directory is served by another adapter process; the entries started here are not part of it.",
		))
		return service
	}
	service.lock = lock
	service.report("starting", "", nil)
	return service
}

func (d *deviceService) report(state, reason string, cause error) {
	status := serviceStatus{PID: os.Getpid(), State: state, Reason: reason, Socket: d.c.deviceSocket(), UpdatedAt: time.Now().UTC().Format(time.RFC3339), Service: d.facts}
	if cause != nil {
		status.Detail = cause.Error()
	}
	_ = writePrivateJSON(d.c.serviceStatusPath(), status)
}

// 永远给不出聚合面的情况，重试没有意义。返回空串表示可以启动。
func (d *deviceService) unavailable() (reason, message string) {
	c := d.c
	if _, err := os.Stat(c.deviceMain()); err != nil {
		return "artifact-missing", fmt.Sprintf(tr("没有找到设备进程的构建产物 %s", "the device process build output %s was not found"), c.deviceMain())
	}
	if runtime.GOOS != "windows" && len(c.deviceSocket()) > 100 {
		return "path-too-long", tr("状态路径过长，无法创建聚合面的 Unix socket，请使用较短的 --home", "the state path is too long for the aggregate endpoint's Unix socket; use a shorter --home")
	}
	return "", ""
}

// 这个状态目录的聚合面归本进程管，而且给得出来。这时候一个 harness 都起不来服务也留着：
// 客户端要连得上，才看得到各自没起来的原因、才有地方改设置再试。
func (d *deviceService) provides() bool {
	if d.lock == nil {
		return false
	}
	reason, _ := d.unavailable()
	return reason == ""
}

// 拿着设备锁的进程才开控制通道。开不起来只告警：客户端里用不了设置和 harness 管理，别的照常。
// shutdown 是让整个服务停下来的那一下：device-stop 经控制通道请服务自己停时调用。
func (d *deviceService) openControl(ctx context.Context, manager *harnessManager, shutdown func()) *controlServer {
	if d.lock == nil {
		return nil
	}
	server, err := openControlServer(ctx, d.c, manager, d.facts, shutdown)
	if err != nil {
		fmt.Fprintf(os.Stderr, tr(
			"警告：设备服务的控制通道没有起来: %v；客户端里的设置和 harness 管理不可用，其余不受影响。\n",
			"Warning: the device service's control channel did not start: %v; settings and harness management are unavailable in the client, everything else is unaffected.\n",
		), err)
		return nil
	}
	return server
}

// release 放掉设备锁，是服务退出前的最后一步，排在设备进程和控制通道都收掉之后。
// 锁一放，等着的 device-start（或者 device-stop 之后紧跟的那一次）就会起新的服务：
// 那时这边要是还有东西没收完（控制通道的套接字还没删），删掉的就可能是新服务刚建的那一个。
func (d *deviceService) release() {
	if d.lock == nil {
		return
	}
	_ = os.Remove(d.c.serviceStatusPath())
	hostplatform.Unlock(d.lock)
	_ = d.lock.Close()
	d.lock = nil
}

// run 跑到 ctx 结束。无论走哪条路都要放行 SSH 入口，设备进程出问题不能卡住它们。
// 设备锁不在这里放，见 release。
func (d *deviceService) run(ctx context.Context, stage *startStage) {
	defer stage.release()
	if d.lock == nil {
		return
	}
	c := d.c
	if reason, message := d.unavailable(); reason != "" {
		d.report("unavailable", reason, errors.New(message))
		fmt.Fprintf(os.Stderr, tr("警告：%s；聚合面（给 Litch 客户端用）未启动，各入口不受影响。\n", "Warning: %s; the aggregate endpoint (used by the Litch client) is not started, entries are unaffected.\n"), message)
		stage.release()
		// 设备锁继续拿着：device-start 据此知道这里有服务在管，只是给不了聚合面，不会另起一份。
		<-ctx.Done()
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-stage.settled:
	case <-time.After(deviceSettleWait):
	}
	// 一个运行时都没起来也要起：客户端连上来才看得到原因，才能在设置里改了再试。
	upstreams := stage.upstreams()
	failing := false
	for delay := deviceRestartDelay; ctx.Err() == nil; {
		started := time.Now()
		wasReady, reason, err := d.runOnce(ctx, upstreams, func() {
			failing = false
			d.report("ready", "", nil)
			fmt.Printf(tr("聚合面就绪: %s\n", "Aggregate endpoint ready: %s\n"), c.deviceSocket())
			stage.release()
		})
		if ctx.Err() != nil {
			return
		}
		if wasReady && time.Since(started) >= deviceStableAfter {
			delay = deviceRestartDelay
		}
		d.report("retrying", reason, err)
		if !failing {
			failing = true
			what := map[string]string{
				"start-failed":  tr("设备进程启动失败", "The device process failed to start"),
				"ready-timeout": tr("设备进程启动超时", "The device process timed out while starting"),
				"exited":        tr("设备进程意外退出", "The device process exited unexpectedly"),
			}[reason]
			fmt.Fprintf(os.Stderr, tr("警告：%s，聚合面暂不可用，会自动重新拉起；日志 %s。各入口不受影响。\n", "Warning: %s. The aggregate endpoint is unavailable for now and will be restarted automatically; log: %s. Entries are unaffected.\n"), what, c.deviceLog())
		}
		stage.release()
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, deviceRestartLimit)
	}
}
