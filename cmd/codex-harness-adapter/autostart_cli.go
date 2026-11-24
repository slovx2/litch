package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

func deviceAutostartCommand(ctx context.Context, args []string) error {
	if len(args) == 0 || (args[0] != "get" && args[0] != "enable" && args[0] != "disable") {
		return errors.New(tr("用法：device-autostart get|enable|disable [--wait] [--home DIR]；变更参数用 JSON 从标准输入传入。", "Usage: device-autostart get|enable|disable [--wait] [--home DIR]; pass mutation parameters as JSON on stdin."))
	}
	// --wait：变更被接受后等到它做完，再报最后的结果（升级换版本时用）。
	wait := false
	rest := []string{}
	for _, arg := range args[1:] {
		if arg == "--wait" && args[0] != "get" {
			wait = true
			continue
		}
		rest = append(rest, arg)
	}
	c, err := parseConfiguration(rest)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if args[0] != "get" {
		const limit = 8192
		raw, err = io.ReadAll(io.LimitReader(os.Stdin, limit+1))
		if err != nil {
			return err
		}
		if len(raw) > limit {
			return errors.New(tr("自启参数过长。", "Autostart parameters are too long."))
		}
	}
	return runDeviceAutostart(ctx, c, args[0], raw, wait)
}

// H 线接到独立子命令：先解析 get/enable/disable 和公共适配器配置，
// 写操作再把契约中的参数交给此函数。CLI 与设备 RPC 共用校验和操作日志。
func runDeviceAutostart(ctx context.Context, c configuration, action string, raw json.RawMessage, wait bool) error {
	h, err := newAutostartHost(c)
	if err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	switch action {
	case "get":
		status, err := h.get(ctx)
		if err != nil {
			return err
		}
		return out.Encode(status)
	case "enable", "disable":
		params, failure := decodeAutostartParams(raw, action == "enable")
		if failure != nil {
			return errors.New(failure.Text.String())
		}
		result, failure := h.queue(ctx, action, params)
		if failure != nil {
			return errors.New(failure.Text.String())
		}
		op, ok := result.(autostartMutationResult)
		if wait && ok && op.State == "accepted" {
			if err := h.release(ctx, op.OperationID); err != nil {
				return err
			}
			return h.awaitOperation(ctx, op.OperationID, out)
		}
		if err := out.Encode(result); err != nil {
			return err
		}
		if ok && op.State == "accepted" {
			return h.release(ctx, op.OperationID)
		}
		return nil
	default:
		return fmt.Errorf(tr("未知自启操作：%s", "unknown autostart action: %s"), action)
	}
}

// awaitAutostartLimit：助手自己最多做 3 分钟，这里多留一点。
var awaitAutostartLimit = 200 * time.Second

// --wait 的结果。state：completed 做完了；busy 旧实例不闲、作罢了（退出码 4）；failed 没做成（退出码 1）。
type autostartWaitResult struct {
	State       string           `json:"state"`
	OperationID string           `json:"operationId"`
	Status      *autostartStatus `json:"status,omitempty"`
	Busy        []busyReason     `json:"busy,omitempty"`
}

// 等这次操作有了结果：读操作日志，不另开通道。助手停旧实例、等新实例就绪，都在日志里落账。
func (h *autostartHost) awaitOperation(ctx context.Context, id string, out *json.Encoder) error {
	deadline := time.Now().Add(awaitAutostartLimit)
	for {
		j, err := readAutostartJournal(h.c)
		if err != nil {
			return err
		}
		finish := func(state string, code int, note string) error {
			result := autostartWaitResult{State: state, OperationID: id}
			if state == "busy" {
				result.Busy = j.Deferred.Busy
			} else if status, err := h.get(ctx); err == nil {
				result.Status = &status
			}
			if err := out.Encode(result); err != nil {
				return err
			}
			if code == 0 {
				return nil
			}
			return &exitError{code: code, err: errors.New(note)}
		}
		switch {
		case j.Deferred != nil && j.Deferred.OperationID == id:
			return finish("busy", exitServiceBusy, fmt.Sprintf(tr("设备服务不闲，没有切换：%s", "The device service is busy and was not switched: %s"), describeBusy(j.Deferred.Busy)))
		case j.Operation == nil || j.Operation.OperationID != id:
			return finish("failed", 1, tr("自启操作被另一项操作取代。", "The autostart operation was superseded by another one."))
		case j.Operation.State == "completed":
			return finish("completed", 0, "")
		case j.Operation.State == "failed" || !j.pending():
			note := tr("自启操作未完成。", "The autostart operation did not finish.")
			if j.Repair != nil {
				note = j.Repair.Text.String()
			}
			return finish("failed", 1, note)
		}
		if err := pause(ctx, deadline, 200*time.Millisecond); err != nil {
			return finish("failed", 1, tr("等待自启操作完成超时。", "Timed out waiting for the autostart operation."))
		}
	}
}
