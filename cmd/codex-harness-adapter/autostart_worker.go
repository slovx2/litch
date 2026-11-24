package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"time"
)

var autostartReadyWait = 55 * time.Second

// H 线仅在内部 device-autostart-worker 子命令分派；系统管理器另起这份进程。
func runDeviceAutostartWorker(ctx context.Context, args []string) error {
	if len(args) != 2 || !filepath.IsAbs(args[0]) {
		return errors.New("the autostart worker requires an absolute state path and a revision")
	}
	revision, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || revision <= 0 {
		return errors.New("invalid autostart operation revision")
	}
	h, err := newAutostartHost(configuration{home: args[0]})
	if err != nil {
		return err
	}
	if h.backend == nil {
		return errors.New("no autostart service manager")
	}
	return h.runWorker(ctx, revision)
}

func (h *autostartHost) changeJournal(id string, apply func(*autostartJournal)) (autostartJournal, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	unlock, err := h.journalLock(ctx)
	if err != nil {
		return autostartJournal{}, err
	}
	defer unlock()
	j, err := readAutostartJournal(h.c)
	if err != nil {
		return j, err
	}
	if j.Operation == nil || j.Operation.OperationID != id || j.Operation.State != "pending" {
		return j, errors.New("autostart operation no longer belongs to this worker")
	}
	apply(&j)
	return j, writeAutostartJournal(h.c, j)
}

func (h *autostartHost) runWorker(ctx context.Context, revision int64) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	unlockWorker, err := autoAcquire(ctx, filepath.Join(h.c.deviceDirectory(), "autostart-worker.lock"))
	if err != nil {
		return err
	}
	defer unlockWorker()
	j, err := readAutostartJournal(h.c)
	if err != nil || j.Operation == nil || j.Revision != revision {
		return err
	}
	id := j.Operation.OperationID
	target := j.Target
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		h.backend.cleanupWorker(cleanup, target, revision)
	}()
	if !j.pending() {
		return nil
	}
	waitUntil := time.Now().Add(35 * time.Second)
	for !j.Released && err == nil {
		if err = pause(ctx, waitUntil, 50*time.Millisecond); err != nil {
			break
		}
		j, err = readAutostartJournal(h.c)
		if err == nil && (!j.pending() || j.Operation.OperationID != id) {
			return nil
		}
	}

	var repair *autostartRepair
	if err == nil {
		// 与既有 device-start 共用启动排队锁，避免接管期间按需连接再拉起一份。
		var unlockStart func()
		unlockStart, err = autoAcquire(ctx, filepath.Join(h.c.deviceDirectory(), "start.lock"))
		if err == nil {
			defer unlockStart()
			repair, err = h.apply(ctx, j)
		}
	}
	var busy *autostartBusyError
	if errors.As(err, &busy) {
		// 旧实例不闲，没有动它：操作记录恢复成这次之前的样子，只留下作罢的原因给等结果的那条命令。
		_, saveErr := h.changeJournal(id, func(current *autostartJournal) { finishDeferred(current, id, busy.busy) })
		return saveErr
	}
	logAutostartError(h.c, err)
	_, saveErr := h.changeJournal(id, func(current *autostartJournal) {
		current.Revision++
		current.Hold = false
		current.Previous, current.PreviousRepair = nil, nil
		current.Operation.State = "completed"
		current.Repair = repair
		if err != nil {
			current.Operation.State = "failed"
			if repair == nil {
				current.Repair = operationFailed(err)
			}
		}
	})
	return saveErr
}

// 带 ifIdle 的操作作罢：恢复这次之前的操作记录，留下原因。
func finishDeferred(j *autostartJournal, id string, busy []busyReason) {
	j.Revision++
	j.Hold = false
	j.Operation, j.Repair = j.Previous, j.PreviousRepair
	j.Previous, j.PreviousRepair = nil, nil
	j.Deferred = &autostartDeferred{OperationID: id, Busy: busy}
}

func (h *autostartHost) apply(ctx context.Context, j autostartJournal) (*autostartRepair, error) {
	id, target := j.Operation.OperationID, j.Target
	status, m, service := h.inspect(ctx, j, target)
	if m.repair != nil {
		return m.repair, autoManagerFailure(m.repair)
	}
	enable := j.Operation.Action == "enable"
	if enable {
		if err := target.validate(); err != nil {
			return nil, err
		}
	}
	held, err := autostartLockState(h.c)
	if err != nil {
		return autoAccess(), err
	}
	if j.StopPID != 0 {
		if !held || status.Instance == nil || service.Service == nil ||
			service.PID != j.StopPID || service.Service.StartedAt != j.StopSince ||
			(!enable && status.Instance.Mode != "managed") {
			return nil, errors.New("device service changed after stop confirmation")
		}
		j, err = h.changeJournal(id, func(current *autostartJournal) { current.Hold = true })
		if err != nil {
			return nil, err
		}
		if err := h.stopExisting(ctx, j); err != nil {
			return nil, err
		}
		if held, err = autostartLockState(h.c); held || err != nil {
			return nil, errors.New("device state is still held after stopping the confirmed service")
		}
		m = h.backend.inspect(ctx, target, j.Registered, j.Candidate)
		if enable && status.Instance.Mode == "managed" && m.repair == nil {
			// 在恢复启动许可前撤掉旧进程残留的失败重试，尤其是路径发生变化的升级。
			if err := h.backend.quiesce(ctx, target); err != nil {
				return nil, err
			}
			m = h.backend.inspect(ctx, target, j.Registered, j.Candidate)
		}
	} else if (enable && held && (status.Instance == nil || status.Instance.Mode != "managed")) ||
		(!enable && m.running) {
		return nil, errors.New("the device service changed after the autostart request")
	}
	if m.repair != nil {
		return m.repair, autoManagerFailure(m.repair)
	}
	if !enable {
		if err := h.backend.remove(ctx, target, m); err != nil {
			return nil, err
		}
		after := h.backend.inspect(ctx, target, j.Registered, j.Candidate)
		if after.registered || after.repair != nil {
			return after.repair, errors.New("autostart registration is still present after removal")
		}
		_, err = h.changeJournal(id, func(current *autostartJournal) {
			current.Registered, current.Candidate = autostartSpec{}, autostartSpec{}
		})
		return nil, err
	}
	// 将新规格写入登记凭据后才交给监督器；部分安装失败仍能识别和卸载。
	var previousCandidateMatches bool
	if j.Candidate.ID != "" {
		previousCandidateMatches = h.backend.inspect(ctx, j.Candidate, j.Registered, j.Candidate).exact
	}
	_, err = h.changeJournal(id, func(current *autostartJournal) {
		if previousCandidateMatches {
			current.Registered = current.Candidate
		}
		current.Candidate, current.Hold = target, false
	})
	if err != nil {
		return nil, err
	}
	if err := h.backend.install(ctx, target, m); err != nil {
		return nil, err
	}
	_, err = h.changeJournal(id, func(current *autostartJournal) {
		current.Registered, current.Candidate = target, autostartSpec{}
	})
	if err != nil {
		return nil, err
	}
	var repair *autostartRepair
	if j.Params.AllowLinger && m.linger != "notApplicable" && m.linger != "enabled" {
		if err := h.backend.linger(ctx); err != nil {
			logAutostartError(h.c, err)
		}
		if after := h.backend.inspect(ctx, target, target); after.linger != "enabled" {
			repair = autoRepair("lingerUnavailable", "无法开启 linger。设备服务仅在用户登录后运行。", "Linger could not be enabled. The device service runs only after sign-in.")
		}
	}
	deadline := time.Now().Add(autostartReadyWait)
	for {
		m := h.backend.inspect(ctx, target, target)
		held, lockErr := autostartLockState(h.c)
		if lockErr != nil {
			return autoAccess(), lockErr
		}
		instance, service := h.instance(m, target, held)
		if m.enabled && m.exact && instance != nil && instance.Mode == "managed" && h.verified(ctx, target, service) {
			return repair, nil
		}
		if m.repair != nil {
			return m.repair, autoManagerFailure(m.repair)
		}
		if err := pause(ctx, deadline, time.Second); err != nil {
			return autoRepair("instanceMismatch", "自启登记已写入，但无法确认服务已启动。请检查设备服务日志。", "The autostart registration was written, but service startup could not be verified. Check the device service logs."), fmt.Errorf("waiting for the registered service: %w", err)
		}
	}
}
