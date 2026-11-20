package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

type autostartParams struct {
	OperationID        string `json:"operationId"`
	ExpectedRevision   *int64 `json:"expectedRevision"`
	ConfirmStop        bool   `json:"confirmStop,omitempty"`
	ResumeAfterRestart bool   `json:"resumeAfterRestart,omitempty"`
	Takeover           bool   `json:"takeover,omitempty"`
	AllowLinger        bool   `json:"allowLinger,omitempty"`
}

type autostartJournal struct {
	Revision   int64 `json:"revision"`
	Registered autostartSpec
	// 仅用于识别中途已写入管理器、但尚未提交完成的规格。
	Candidate autostartSpec
	Target    autostartSpec
	Operation *autostartOperation
	Params    autostartParams
	Expires   time.Time
	Released  bool
	Hold      bool
	StopPID   int
	StopSince string
	Repair    *autostartRepair
}

func (j autostartJournal) pending() bool {
	return j.Operation != nil && j.Operation.State == "pending" && time.Now().Before(j.Expires)
}

func autostartJournalPath(c configuration) string {
	return filepath.Join(c.deviceDirectory(), "autostart.json")
}

func readAutostartJournal(c configuration) (autostartJournal, error) {
	var record autostartJournal
	raw, err := os.ReadFile(autostartJournalPath(c))
	if errors.Is(err, os.ErrNotExist) {
		return record, nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &record)
	}
	return record, err
}

func writeAutostartJournal(c configuration, record autostartJournal) error {
	return writePrivateJSON(autostartJournalPath(c), record)
}

func autoAcquire(ctx context.Context, name string) (func(), error) {
	dir := filepath.Dir(name)
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		if err := hostplatform.Protect(dir); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		err = hostplatform.Lock(file)
		if err == nil {
			return func() {
				hostplatform.Unlock(file)
				_ = file.Close()
			}, nil
		}
		if !autostartLockContended(err) {
			break
		}
		if err = pause(ctx, time.Now().Add(time.Second), 20*time.Millisecond); err != nil {
			break
		}
	}
	_ = file.Close()
	return nil, err
}

func (h *autostartHost) inspect(ctx context.Context, j autostartJournal, target autostartSpec) (autostartStatus, autostartManagerState, serviceStatus) {
	status := autostartStatus{Revision: j.Revision, ServiceManager: "unsupported", State: "unsupported", Linger: "notApplicable", LastOperation: j.Operation}
	if j.Operation != nil && j.Operation.State == "pending" && !j.pending() {
		expired := *j.Operation
		expired.State = "failed"
		status.LastOperation = &expired
		status.Repair = autoRepair("operationInterrupted", "自启操作未完成；请检查当前登记后重试。", "The autostart operation was interrupted. Review the current registration and try again.")
	} else if j.Repair != nil {
		status.Repair = j.Repair
	}
	if h.backend == nil {
		return status, autostartManagerState{}, serviceStatus{}
	}
	status.ServiceManager = h.backend.name()
	status.ServiceID = h.spec.ID
	m := h.backend.inspect(ctx, target, j.Registered, j.Candidate)
	status.Linger = m.linger
	status.RequiresLogin = m.linger != "enabled"
	identity := j.Registered
	if identity.ID == "" {
		identity = j.Candidate
	}
	held, lockErr := autostartLockState(h.c)
	instance, service := h.instance(m, identity, held)
	status.Instance = instance
	switch {
	case m.repair != nil:
		status.State, status.Repair = "degraded", m.repair
	case lockErr != nil:
		status.State, status.Repair = "degraded", autoAccess()
	case !m.registered:
		status.State = "disabled"
		if instance != nil && status.Repair == nil {
			if service.Service.Detached {
				status.Repair = autoRepair("manualInstance", "当前设备服务由 Litch 按需启动。若要启用自启，请确认接管。", "Litch started the device service on demand. Confirm takeover to enable autostart.")
			} else {
				status.Repair = autoRepair("foregroundInstance", "无法确认现有前台服务归属。请用原启动方式停止它，再启用自启。", "The existing foreground service has unverified ownership. Stop it using its original controls, then enable autostart.")
			}
		}
	case m.enabled && m.running && instance != nil && instance.Mode == "managed" && m.exact:
		status.State = "enabled"
		if !autostartBuildMatches(target, service.Service) {
			status.State = "degraded"
			status.Repair = autoRepair("instanceVersionMismatch", "运行中的服务与已登记的版本不一致；请重新启用自启以应用当前版本。", "The running service does not match the registered version. Enable autostart again to apply the current version.")
		}
	default:
		status.State = "degraded"
		if status.Repair == nil {
			status.Repair = m.issue
			if status.Repair == nil {
				status.Repair = autoRepair("registrationMismatch", "自启登记和运行实例不一致；请检查设备服务或重新启用自启。", "Autostart registration and the running instance differ. Check the device service or enable autostart again.")
			}
		}
	}
	return status, m, service
}

func (h *autostartHost) get(ctx context.Context) (autostartStatus, error) {
	j, err := readAutostartJournal(h.c)
	if err != nil {
		return autostartStatus{}, err
	}
	target := h.spec
	if j.Registered.ID != "" {
		target = j.Registered
	} else if j.Candidate.ID != "" {
		target = j.Candidate
	}
	status, _, _ := h.inspect(ctx, j, target)
	return status, nil
}

type autostartReadiness struct {
	State     string           `json:"state"` // ready、notReady、unverified
	CheckedAt time.Time        `json:"checkedAt"`
	Status    autostartStatus  `json:"status"`
	Repair    *autostartRepair `json:"repair,omitempty"`
}

// 探针只查管理器、文件与控制通道。绝不创建文件、注册服务或唤醒进程。
func (h *autostartHost) readiness(ctx context.Context) (autostartReadiness, error) {
	j, err := readAutostartJournal(h.c)
	if err != nil {
		return autostartReadiness{}, err
	}
	target := h.spec
	if j.Registered.ID != "" {
		target = j.Registered
	} else if j.Candidate.ID != "" {
		target = j.Candidate
	}
	status, m, service := h.inspect(ctx, j, target)
	result := autostartReadiness{State: "notReady", CheckedAt: time.Now().UTC(), Status: status, Repair: status.Repair}
	switch {
	case status.State == "unsupported" || (m.repair != nil && !m.foreign):
		result.State = "unverified"
	case status.State == "disabled" && result.Repair == nil:
		result.Repair = autoRepair("notRegistered", "请先为设备服务启用系统自启。", "Enable system autostart for the device service first.")
	case status.State == "enabled":
		held, lockErr := autostartLockState(h.c)
		if lockErr != nil {
			result.State, result.Repair = "unverified", autoAccess()
			return result, nil
		}
		if target.validate() != nil {
			result.Repair = autoRepair("invalidExecutable", "请检查已登记的适配器、Node 和状态目录权限。", "Check the registered adapter, Node, and state directory permissions.")
			return result, nil
		}
		if !held || j.pending() || !h.verified(ctx, target, service) {
			result.Repair = autoRepair("instanceMismatch", "尚未确认当前自启实例、聚合面及版本；请检查服务状态或重新启用自启。", "The autostart instance, device endpoint, and version could not be verified. Check the service or enable autostart again.")
			return result, nil
		}
		result.State = "ready"
		// 仅登录后的限制由 status.requiresLogin 单独表示。
	}
	return result, nil
}
