package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
	"unicode/utf16"
)

type autostartMutationResult struct {
	State       string           `json:"state"`
	Status      *autostartStatus `json:"status,omitempty"`
	OperationID string           `json:"operationId,omitempty"`
	Reconnect   *bool            `json:"reconnect,omitempty"`
}

func autoRejected(reason, zh, en string) *controlError {
	return &controlError{Reason: reason, Text: both(zh, en)}
}

func autoAccepted(j autostartJournal) autostartMutationResult {
	reconnect := j.StopPID > 0
	return autostartMutationResult{State: "accepted", OperationID: j.Operation.OperationID, Reconnect: &reconnect}
}

func autoCompleted(status autostartStatus) autostartMutationResult {
	return autostartMutationResult{State: "completed", Status: &status}
}

func decodeAutostartParams(raw json.RawMessage, enable bool) (params autostartParams, failure *controlError) {
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) == nil && json.Unmarshal(raw, &params) == nil &&
		params.OperationID != "" && len(utf16.Encode([]rune(params.OperationID))) <= 128 &&
		params.ExpectedRevision != nil && *params.ExpectedRevision >= 0 && *params.ExpectedRevision <= (1<<53)-1 {
		for key, value := range keys {
			switch key {
			case "operationId", "expectedRevision":
				continue
			case "takeover", "allowLinger":
				if !enable {
					goto invalid
				}
			case "confirmStop", "resumeAfterRestart":
			default:
				goto invalid
			}
			if string(value) != "true" && string(value) != "false" {
				goto invalid
			}
		}
		return params, nil
	}
invalid:
	return params, autoRejected("invalid", "自启操作参数不正确。", "Invalid autostart operation parameters.")
}

func (h *autostartHost) journalLock(ctx context.Context) (func(), error) {
	return autoAcquire(ctx, filepath.Join(h.c.deviceDirectory(), "autostart.lock"))
}

func (h *autostartHost) queue(ctx context.Context, action string, params autostartParams) (any, *controlError) {
	if h.backend == nil {
		return nil, autoRejected("failed", "当前设备不支持系统自启。", "System autostart is unavailable on this device.")
	}
	unlock, err := h.journalLock(ctx)
	if err != nil {
		return nil, controlFailure(err)
	}
	defer unlock()
	j, err := readAutostartJournal(h.c)
	if err != nil {
		return nil, controlFailure(err)
	}
	if j.Operation != nil && j.Operation.OperationID == params.OperationID {
		if j.Operation.Action != action || !reflect.DeepEqual(j.Params, params) {
			return nil, autoRejected("conflict", "操作标识已用于另一项自启请求。", "This operation ID is already in use for a different autostart request.")
		}
		if j.pending() {
			return autoAccepted(j), nil
		}
		status, err := h.get(ctx)
		if err != nil {
			return nil, controlFailure(err)
		}
		return autoCompleted(status), nil
	}
	if j.Revision != *params.ExpectedRevision {
		return nil, autoRejected("conflict", "自启状态已变化，请刷新后重试。", "Autostart state changed. Refresh it and try again.")
	}
	if j.pending() {
		return nil, autoRejected("busy", "已有自启操作正在执行。", "An autostart operation is already in progress.")
	}

	status, m, service := h.inspect(ctx, j, h.spec)
	if m.repair != nil {
		return nil, &controlError{Reason: "failed", Text: m.repair.Text}
	}
	if action == "disable" && !m.registered {
		return autoCompleted(status), nil
	}
	if action == "enable" {
		if err := h.spec.validate(); err != nil {
			return nil, autoRejected("failed", "自启需要可直接执行的适配器和 Node，以及可访问的状态目录。", "Autostart requires executable adapter and Node files and an accessible state directory.")
		}
		if status.State == "enabled" && (h.spec == j.Registered || h.spec == j.Candidate) &&
			(!params.AllowLinger || status.Linger == "enabled" || status.Linger == "notApplicable") &&
			h.verified(ctx, h.spec, service) {
			return autoCompleted(status), nil
		}
	}
	held, err := autostartLockState(h.c)
	if err != nil {
		return nil, &controlError{Reason: "failed", Text: autoAccess().Text}
	}
	if (m.running && (status.Instance == nil || status.Instance.Mode != "managed")) ||
		(action == "enable" && ((held && status.Instance == nil) ||
			(!held && (canDial(h.c.deviceSocket()) || liveRuntime(h.c) != "")))) {
		return nil, autoRejected("busy", "无法确认当前运行实例的归属；请先检查设备服务。", "The running service could not be identified. Check the device service first.")
	}
	stop := status.Instance != nil && ((action == "enable" && (status.Instance.Mode == "manual" ||
		!m.exact || !m.enabled || service.Service.Build != h.spec.Build || service.Service.Version != h.spec.Version)) ||
		(action == "disable" && status.Instance.Mode == "managed"))
	if stop && status.Instance.Mode == "manual" && !params.Takeover {
		return nil, autoRejected("conflict", "同一状态目录已有设备服务。请先确认接管。", "A device service is already using this state directory. Confirm takeover first.")
	}
	if stop && status.Instance.Mode == "manual" && !service.Service.Detached {
		// 现有前台实例没有按需启动标记，设备无法证明它不受其他监督器管理。
		// 停掉它可能让原监督器重新启动。要求用户先用原启动方式停止。
		return nil, autoRejected("conflict", "无法确认现有前台服务由 Litch 启动。请用原启动方式停止它，再启用自启。", "Litch cannot verify that it started the foreground service. Stop it using its original controls, then enable autostart.")
	}
	if stop && !params.ConfirmStop {
		return nil, autoRejected("busy", "此操作会停止当前设备服务。请先确认停机以及是否续跑。", "This operation stops the current device service. Confirm the stop and choose whether to resume work.")
	}
	j.Operation = &autostartOperation{OperationID: params.OperationID, Action: action, State: "pending"}
	j.Params, j.Revision, j.Expires, j.Repair = params, j.Revision+1, time.Now().Add(4*time.Minute), nil
	j.Hold, j.Released, j.StopPID, j.StopSince = false, false, 0, ""
	j.Target = h.spec
	if stop {
		j.StopPID, j.StopSince = service.PID, service.Service.StartedAt
	}
	if err := writeAutostartJournal(h.c, j); err != nil {
		return nil, controlFailure(err)
	}
	if err := h.backend.enqueue(ctx, j.Target, j.Revision); err != nil {
		j.Operation.State, j.Revision = "failed", j.Revision+1
		j.Repair = operationFailed(err)
		if saveErr := writeAutostartJournal(h.c, j); saveErr != nil {
			return nil, controlFailure(saveErr)
		}
		return nil, &controlError{Reason: "failed", Text: j.Repair.Text}
	}
	return autoAccepted(j), nil
}

// RPC 应答已发出以后由设备进程调用。独立助手在此之前不会停止服务。
func (h *autostartHost) release(ctx context.Context, id string) error {
	unlock, err := h.journalLock(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	j, err := readAutostartJournal(h.c)
	if err != nil || !j.pending() || j.Operation.OperationID != id || j.Released {
		return err
	}
	j.Released = true
	return writeAutostartJournal(h.c, j)
}

// H 在私有本机控制通道分派这五个方法。公网设备 RPC 只暴露前三个。
func (s *controlServer) handleAutostart(method string, raw json.RawMessage) (any, *controlError) {
	ctx, cancel := context.WithTimeout(s.ctx, 70*time.Second)
	defer cancel()
	h, err := newAutostartHost(s.c)
	if err != nil {
		return nil, controlFailure(err)
	}
	switch method {
	case "autostart.enable", "autostart.disable":
		action := strings.TrimPrefix(method, "autostart.")
		params, failure := decodeAutostartParams(raw, action == "enable")
		if failure != nil {
			return nil, failure
		}
		return h.queue(ctx, action, params)
	case "autostart.release":
		var p struct {
			OperationID string `json:"operationId"`
		}
		if json.Unmarshal(raw, &p) != nil || p.OperationID == "" {
			return nil, autoRejected("invalid", "缺少自启操作标识。", "Missing autostart operation ID.")
		}
		err = h.release(ctx, p.OperationID)
	case "autostart.get":
		var result autostartStatus
		if result, err = h.get(ctx); err == nil {
			return result, nil
		}
	case "autostart.readiness":
		var result autostartReadiness
		if result, err = h.readiness(ctx); err == nil {
			return result, nil
		}
	default:
		err = errors.New("unknown autostart control method")
	}
	if err != nil {
		return nil, controlFailure(err)
	}
	return struct{}{}, nil
}

func operationFailed(err error) *autostartRepair {
	if errors.Is(err, os.ErrPermission) || autoPermissionError(err.Error()) {
		return autoAccess()
	}
	return autoRepair("operationFailed", "自启操作未完成；请检查系统服务管理器和设备服务日志后重试。", "Autostart did not finish. Check the system service manager and device service logs, then retry.")
}

func logAutostartError(c configuration, err error) {
	if err == nil {
		return
	}
	f, openErr := os.OpenFile(filepath.Join(c.deviceDirectory(), "autostart.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if openErr == nil {
		defer f.Close()
		_, _ = fmt.Fprintf(f, "%s %v\n", time.Now().UTC().Format(time.RFC3339), err)
	}
}
