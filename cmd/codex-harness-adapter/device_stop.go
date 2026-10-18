package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// device-stop：把这个状态目录上的常驻服务平稳停掉，并等它退出。
// 客户端换版本时用（先停旧的，再用自带的那份 device-start），人也可以直接用（安装脚本升级之后的提示）。
//
// 结果是标准输出的一行 JSON，给人看的一句话在标准错误里；调用方按退出码区分：
//   0  这个状态目录上现在没有常驻服务了：本来就没有（"result":"notRunning"），或者这次停掉了（"stopped"）。
//      所以它是幂等的，没在运行也算成功
//   3  有一份不带聚合面的服务在运行（"withoutAggregate"，多半是旧版）。它不拿设备锁，不归这条命令管，没有动它
//   4  带了 --if-idle 而服务不闲（"busy"）：没有停，busy 里逐条是原因（control_service.go 的 busyReason）
//   5  有服务在运行，但没法请它停（"unsupported"）：它不认识停止的请求（比这条命令出现得早），
//      或者它的控制通道连不上。没有动它
//   1  别的：答应了停却迟迟没有退出、参数错误、被中断。这时标准输出是空的
//
// 停的办法是经控制通道请它自己停（service.stop），不按进程号发信号。控制通道的套接字在只有属主能进的
// 状态目录里，只有拿着设备锁的那个进程才去监听它，所以答话的一定是拿着锁的那一个；
// service.json 里记的进程号可能是过期的（服务被强杀之后文件还在，那个号也许已经归了别的进程），
// 这里从不拿它去结束谁。

const (
	exitServiceBusy       = 4
	exitStopNotSupported  = 5
	stopResultNotRunning  = "notRunning"
	stopResultStopped     = "stopped"
	stopResultBusy        = "busy"
	stopResultUnsupported = "unsupported"
	stopResultLegacy      = "withoutAggregate"
)

var (
	// 服务答应停之后等它退出最多等这么久：每个运行时、设备进程各有 5 秒的收尾时间，是先后收的。
	deviceStopTimeout = 45 * time.Second
	// 等服务答 service.stop 最多等这么久。带 --if-idle 时它要先问一圈忙不忙（activityTimeout）。
	deviceStopReplyTimeout = 40 * time.Second
	// 设备锁有人拿着、控制通道却还连不上时再等这么久：服务可能刚拿到锁，通道还没开；
	// 也可能只是另一条命令在探测锁（探测时会短暂占住它）。
	deviceStopControlWait = 2 * time.Second
	// 对面的连接关了、设备锁也放了之后，再等它的进程消失最多等这么久。
	deviceStopExitGrace = 3 * time.Second
)

type deviceStopResult struct {
	Result string `json:"result"`
	// 被停掉的（或者不肯停的）那个常驻进程，是它自己在应答里报的。
	PID int `json:"pid,omitempty"`
	// 它的来历（service_facts.go）。
	Service *serviceFacts `json:"service,omitempty"`
	// busy：不闲的原因。
	Busy []busyReason `json:"busy,omitempty"`
	// withoutAggregate：连得上的是哪个 harness 的运行时。
	Harness string `json:"harness,omitempty"`
}

// 打出结果的那一行，并给出对应的退出码。说明只有一句，走标准错误。
func finishDeviceStop(result deviceStopResult, code int, note string) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		return err
	}
	if code == 0 {
		fmt.Fprintln(os.Stderr, note)
		return nil
	}
	return &exitError{code: code, err: errors.New(note)}
}

// 把不闲的原因说成一句话。
func describeBusy(reasons []busyReason) string {
	parts := []string{}
	for _, reason := range reasons {
		names := strings.Join(reason.Harnesses, tr("、", ", "))
		switch reason.Reason {
		case "activeTurns":
			parts = append(parts, fmt.Sprintf(tr("%s 有回合在跑（或者判断不了）", "%s has a turn in progress (or that cannot be determined)"), names))
		case "deviceProcesses":
			parts = append(parts, fmt.Sprintf(tr("有 %d 个属于设备的终端在跑", "%d device-owned terminal(s) are running"), reason.Count))
		case "tasks":
			parts = append(parts, fmt.Sprintf(tr("有 %d 次定时任务的运行在跑", "%d scheduled task run(s) are in progress"), reason.Count))
		case "clients":
			parts = append(parts, fmt.Sprintf(tr("有 %d 个客户端连着", "%d client(s) are connected"), reason.Count))
		case "undetermined":
			parts = append(parts, fmt.Sprintf(tr("设备进程没有应答，判断不了 %s 有没有回合在跑", "the device process did not answer, so it is unknown whether %s has a turn in progress"), names))
		default:
			parts = append(parts, reason.Reason)
		}
	}
	return strings.Join(parts, tr("；", "; "))
}

func deviceStop(ctx context.Context, c configuration) error {
	connection, held := dialServiceControl(ctx, c)
	if connection == nil {
		if ctx.Err() != nil {
			return errors.New(tr("已中断", "interrupted"))
		}
		if held {
			return stopUnsupported(c, tr("它的控制通道连不上", "its control channel cannot be reached"))
		}
		if harness := liveRuntime(c); harness != "" {
			return finishDeviceStop(deviceStopResult{Result: stopResultLegacy, Harness: harness}, exitServiceWithoutAggregate, fmt.Sprintf(tr(
				"这个状态目录上有一份不带聚合面的适配器服务在运行（%s 的运行时连得上）。它不归这条命令管，没有动它；请用启动它的方式停掉它",
				"An adapter service without the aggregate endpoint is running on this state directory (the %s runtime is reachable). This command does not manage it and left it alone; stop it the way it was started",
			), harness))
		}
		if canDial(c.deviceSocket()) {
			return stopUnsupported(c, tr("聚合面有人在提供，却没有人拿着设备锁：它不是常驻服务起的（比如开发用的夹具）", "something serves the aggregate endpoint without holding the device lock: it was not started by the service (a development fixture, for example)"))
		}
		return finishDeviceStop(deviceStopResult{Result: stopResultNotRunning}, 0, tr("这个状态目录上没有常驻服务在运行。", "No service is running on this state directory."))
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	reply, known, err := requestServiceStop(connection, c.ifIdle)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New(tr("已中断", "interrupted"))
		}
		return fmt.Errorf(tr("常驻服务没有答复停止的请求: %w", "the service did not answer the stop request: %w"), err)
	}
	if !known {
		return stopUnsupported(c, tr("它不认识停止的请求（它比 device-stop 这条命令出现得早）", "it does not understand the stop request (it predates the device-stop command)"))
	}
	result := deviceStopResult{PID: reply.PID, Service: reply.Service}
	if !reply.Stopping {
		result.Result, result.Busy = stopResultBusy, reply.Busy
		return finishDeviceStop(result, exitServiceBusy, fmt.Sprintf(tr(
			"没有停：服务不闲（%s）。等它闲下来再试；去掉 --if-idle 会直接停掉它，正在进行的事会被打断",
			"Not stopped: the service is busy (%s). Try again when it is idle; without --if-idle it is stopped anyway, interrupting whatever is in progress",
		), describeBusy(reply.Busy)))
	}
	if err := awaitServiceExit(ctx, c, connection, reply.PID); err != nil {
		return err
	}
	result.Result = stopResultStopped
	return finishDeviceStop(result, 0, fmt.Sprintf(tr("已停止常驻服务（进程 %d）。", "Stopped the service (process %d)."), reply.PID))
}

// 有服务在跑，但没法请它停。记下的进程号只是给人看的线索：是它自己早先写的，这里没有办法核对，也不拿它去结束谁。
func stopUnsupported(c configuration, why string) error {
	result := deviceStopResult{Result: stopResultUnsupported}
	hint := ""
	if status, ok := readServiceStatus(c); ok && deviceLockHeld(c) {
		result.PID, result.Service = status.PID, status.Service
		hint = fmt.Sprintf(tr("；它自己记下的进程号是 %d，确认是它之后可以直接结束这个进程", "; the process id it recorded is %d — once you have confirmed that is the service, end that process directly"), status.PID)
	}
	return finishDeviceStop(result, exitStopNotSupported, fmt.Sprintf(tr(
		"这个状态目录上有服务在运行，但这条命令停不了它：%s%s",
		"A service is running on this state directory, but this command cannot stop it: %s%s",
	), why, hint))
}

// 连上拿着设备锁的那个进程的控制通道。连不上时返回 nil，held 说明设备锁是不是确实有人拿着。
func dialServiceControl(ctx context.Context, c configuration) (connection net.Conn, held bool) {
	path := hostplatform.ControlSocketPath(c.deviceDirectory())
	deadline := time.Now().Add(deviceStopControlWait)
	for {
		if !deviceLockHeld(c) {
			return nil, false
		}
		if connection, err := hostplatform.Dial(path); err == nil {
			return connection, true
		}
		if pause(ctx, deadline, 50*time.Millisecond) != nil {
			return nil, deviceLockHeld(c)
		}
	}
}

// 发 service.stop，等它的应答。known 为 false：对面答的是 error，它不认识这个请求。
func requestServiceStop(connection net.Conn, ifIdle bool) (reply stopReply, known bool, err error) {
	request, err := json.Marshal(map[string]any{"id": 1, "method": "service.stop", "params": map[string]any{"ifIdle": ifIdle}})
	if err != nil {
		return reply, false, err
	}
	_ = connection.SetDeadline(time.Now().Add(deviceStopReplyTimeout))
	defer connection.SetDeadline(time.Time{})
	if _, err := connection.Write(append(request, '\n')); err != nil {
		return reply, false, err
	}
	reader := bufio.NewReaderSize(connection, 64*1024)
	for {
		line, err := readControlLine(reader)
		if err != nil {
			return reply, false, err
		}
		var frame struct {
			ID     *int            `json:"id"`
			Ask    *int            `json:"ask"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &frame) != nil {
			continue
		}
		if frame.Ask != nil {
			// 服务在问设备进程的事，问到这条连接上来了：答一句“不是”，它好去等真的设备进程。
			answer, _ := json.Marshal(map[string]any{"reply": *frame.Ask, "error": "not the device process"})
			if _, err := connection.Write(append(answer, '\n')); err != nil {
				return reply, false, err
			}
			continue
		}
		// 别的（state）不是给这条命令的。
		if frame.ID == nil || *frame.ID != 1 {
			continue
		}
		if len(frame.Error) > 0 || len(frame.Result) == 0 {
			return reply, false, nil
		}
		if err := json.Unmarshal(frame.Result, &reply); err != nil || reply.PID <= 0 {
			return reply, false, nil
		}
		return reply, true, nil
	}
}

// 等答应了停的那份服务退出。它收场的次序是：运行时、设备进程、控制通道（这条连接到这里才断）、设备锁、进程退出。
// 所以连接断了之后，设备锁放了或者进程没了，任何一样都说明它收完了；两样分开看，是因为各有看不准的时候：
// 锁可能转眼被紧跟着起来的新服务拿走，进程号也可能留着一个还没被收走的僵尸。
func awaitServiceExit(ctx context.Context, c configuration, connection net.Conn, pid int) error {
	deadline := time.Now().Add(deviceStopTimeout)
	late := func() error {
		return fmt.Errorf(tr(
			"常驻服务（进程 %d）答应了停止，但 %s 内没有退出。可以再运行一次 device-stop 看它退了没有",
			"the service (process %d) agreed to stop but did not exit within %s. Run device-stop again to see whether it has exited",
		), pid, deviceStopTimeout)
	}
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		_ = connection.SetReadDeadline(deadline)
		buffer := make([]byte, 4096)
		for {
			if _, err := connection.Read(buffer); err != nil {
				return
			}
		}
	}()
	<-closed
	for hostplatform.Running(pid) && deviceLockHeld(c) {
		if err := pause(ctx, deadline, 50*time.Millisecond); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return late()
			}
			return errors.New(tr("已中断", "interrupted"))
		}
	}
	// 锁先放、进程后退：再等一小会儿让它退干净，等不到也不算失败。
	grace := time.Now().Add(deviceStopExitGrace)
	for hostplatform.Running(pid) && pause(ctx, grace, 20*time.Millisecond) == nil {
	}
	return nil
}
