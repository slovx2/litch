package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 检查的是设备当前锁持有者的专用通道；不按猜测的 PID 发信号。
func (h *autostartHost) dialVerified(ctx context.Context, pid int, since string) (net.Conn, *serviceFacts, error) {
	conn, err := hostplatform.Dial(hostplatform.ControlSocketPath(h.c.deviceDirectory()))
	if err != nil {
		return nil, nil, err
	}
	deadline := time.Now().Add(3 * time.Second)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	_ = conn.SetReadDeadline(deadline)
	line, err := readControlLine(bufio.NewReaderSize(conn, 64*1024))
	var frame struct {
		Method string `json:"method"`
		Params struct {
			Service *serviceFacts `json:"service"`
		} `json:"params"`
	}
	if err == nil {
		err = json.Unmarshal(line, &frame)
	}
	service := frame.Params.Service
	if err != nil || frame.Method != "state" || service == nil || service.PID != pid || service.StartedAt != since {
		_ = conn.Close()
		return nil, nil, errors.New("device service identity changed or control channel did not identify itself")
	}
	_ = conn.SetReadDeadline(time.Time{})
	return conn, service, nil
}

func (h *autostartHost) verified(ctx context.Context, spec autostartSpec, service serviceStatus) bool {
	if service.State != "ready" || service.Service == nil || !canDial(h.c.deviceSocket()) {
		return false
	}
	conn, facts, err := h.dialVerified(ctx, service.PID, service.Service.StartedAt)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return autostartBuildMatches(spec, facts) && slices.Contains(facts.Options, autostartFlag+spec.ID)
}

func autostartBuildMatches(spec autostartSpec, facts *serviceFacts) bool {
	fi, err := os.Stat(spec.Executable)
	if err != nil {
		return false
	}
	build := fmt.Sprintf("%d-%d", fi.ModTime().UnixNano(), fi.Size())
	return facts.Root == spec.Root && facts.Version == spec.Version && facts.Build == build &&
		facts.Build == spec.Build
}

// 带 ifIdle 的启用遇到旧实例不闲：没有停它，整个操作作罢。
type autostartBusyError struct{ busy []busyReason }

func (e *autostartBusyError) Error() string {
	return "the device service is busy: " + describeBusy(e.busy)
}

// 不闲的原因只有客户端连着：发起切换的那一端自己就连着，断了会自己重连，不算要等的事。
func onlyClientsBusy(reasons []busyReason) bool {
	return len(reasons) > 0 && !slices.ContainsFunc(reasons, func(r busyReason) bool { return r.Reason != "clients" })
}

func (h *autostartHost) stopExisting(ctx context.Context, j autostartJournal) error {
	ifIdle := j.Params.IfIdle
	for {
		conn, _, err := h.dialVerified(ctx, j.StopPID, j.StopSince)
		if err != nil {
			return err
		}
		stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
		reply, known, err := requestServiceStop(conn, ifIdle, j.Params.ResumeAfterRestart)
		if err == nil && known && !reply.Stopping && ifIdle && reply.PID == j.StopPID {
			stop()
			_ = conn.Close()
			if !onlyClientsBusy(reply.Busy) {
				return &autostartBusyError{busy: reply.Busy}
			}
			// 只是有客户端连着：照停，客户端会自己重连到新实例。
			ifIdle = false
			continue
		}
		if err == nil && (!known || !reply.Stopping || reply.PID != j.StopPID) {
			err = errors.New("the expected device service did not agree to stop")
		}
		if err == nil {
			err = awaitServiceExit(ctx, h.c, conn, reply.PID)
		}
		stop()
		_ = conn.Close()
		return err
	}
}

// H 线在 run 解析通用参数之前调用。受管入口严格核对参数和登记的规格，
// 并清除监督器继承的环境；设备自己的显式 env 与设置仍由正常 start 读取。
// held 为 true 时直接成功退出；否则将 marker 追加到解析后的 c.launch，供设备锁和控制通道核验。
func prepareAutostartStart(args []string) (clean []string, marker string, held bool, err error) {
	if len(args) < 3 || args[0] != "start" || !strings.HasPrefix(args[1], autostartFlag) {
		return args, "", false, nil
	}
	if len(args) < 4 || args[2] != "--home" || !filepath.IsAbs(args[3]) {
		return nil, "", false, errors.New("invalid managed start options")
	}
	c := configuration{home: args[3]}
	j, err := readAutostartJournal(c)
	if err != nil {
		return nil, "", false, err
	}
	spec := j.Registered
	if !slices.Equal(args, spec.args()) {
		spec = j.Candidate
		if !slices.Equal(args, spec.args()) {
			return nil, "", false, errors.New("unregistered managed start options")
		}
	}
	if j.pending() && j.Hold {
		// 计划停止位于管理器的失败重试窗口内时，令排队的同一服务干净退出。
		return nil, "", true, nil
	}
	env := autostartServiceEnv(spec.Node)
	os.Clearenv()
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		if err := os.Setenv(key, value); err != nil {
			return nil, "", false, err
		}
	}
	return append([]string{args[0]}, args[2:]...), args[1], false, nil
}

func isAutostartManaged(c configuration) bool {
	return slices.ContainsFunc(c.launch, func(arg string) bool { return strings.HasPrefix(arg, autostartFlag) })
}
