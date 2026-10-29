package main

import (
	"context"
	"time"
)

// 所有策略在同一把锁内重算；时间来自 Go 的单调时钟，不依赖 Node 的墙钟。
func (p *powerController) reconcile() bool {
	if p.closed {
		return false
	}
	now, config := p.now(), p.settings()
	settingsChanged := config != p.lastSettings
	p.lastSettings = config
	state := powerStatus{Supported: p.backend.supported(), ConfiguredForLocalService: config.local,
		State: "inactive", PowerSource: p.source, Reasons: []string{},
		Text: both("当前未阻止系统休眠", "Not preventing sleep")}
	if !config.local || !state.Supported {
		p.release()
		if !state.Supported {
			state.State = "unsupported"
			state.Text = both("此平台暂不支持阻止系统休眠", "Preventing sleep is not supported on this platform")
		} else {
			state.Text = both("此服务未登记为本机设备，不应用电源设置", "This service is not registered as a local device; power settings do not apply")
		}
		return p.setStatus(state)
	}
	if p.sourceAt.IsZero() || !now.Before(p.sourceAt) {
		ctx, cancel := context.WithTimeout(p.ctx, 2*time.Second)
		source, err := p.backend.source(ctx)
		cancel()
		if err != nil || (source != "ac" && source != "battery") {
			source = "unknown"
		}
		if err != nil && (p.sourceAt.IsZero() || p.source != "unknown") {
			p.record("source_failed", map[string]any{"error": err.Error()})
		}
		p.source, p.sourceAt = source, now.Add(powerSourcePoll)
	}
	state.PowerSource = p.source
	unknown, expired := p.generation == "" || !p.lastComplete || p.invalidActivity || p.connectionLost || now.Sub(p.lastActivity) >= powerEvidenceTTL, false
	for _, evidence := range p.evidence {
		stale := now.Sub(evidence.observed) >= powerEvidenceTTL
		unknown = unknown || evidence.unknown || stale
		if stale {
			expired = expired || evidence.working > 0
		} else {
			state.Working += evidence.working
		}
	}
	if config.working && state.Working > 0 {
		state.Reasons = append(state.Reasons, "working")
	}
	if config.plugged && p.source == "ac" {
		state.Reasons = append(state.Reasons, "pluggedIn")
	}
	wanted := len(state.Reasons) > 0
	if settingsChanged {
		p.failures = 0
		p.failed = false
		p.retryAt = time.Time{}
	}
	if !wanted {
		// 未知证据到期、拔电和设置关闭不享受额外的释放宽限。
		immediate := settingsChanged || expired || (hasPowerReason(p.status, "pluggedIn") && p.source != "ac")
		if p.lease != nil && !immediate && p.releaseAt.IsZero() && p.status.Working > 0 {
			p.releaseAt = now.Add(powerReleaseGrace)
		}
		if immediate || p.releaseAt.IsZero() || !now.Before(p.releaseAt) {
			p.release()
		}
		p.failures = 0
		p.failed = false
		p.retryAt = time.Time{}
	} else {
		p.releaseAt = time.Time{}
		if p.lease != nil && p.lease.exited() {
			p.lease = nil
			p.failed = true
			p.failures++
			p.retryAt = now.Add(powerRetryDelay(p.failures))
			p.record("lease_exited", nil)
		}
		if (p.lease == nil || !now.Before(p.renewAt)) && p.failures < 4 && !now.Before(p.retryAt) {
			lease, err := p.backend.start(p.ctx)
			if err != nil {
				p.failures++
				p.failed = true
				p.retryAt = now.Add(powerRetryDelay(p.failures))
				p.record("lease_failed", map[string]any{"attempt": p.failures, "error": err.Error()})
			} else {
				// 新租约启动并通过存活检查之后，才回收旧租约，续租没有主动空窗。
				old := p.lease
				p.lease, p.renewAt = lease, now.Add(powerLeaseRenew)
				if old != nil {
					old.stop()
					p.failures = 0
				}
				p.failed = false
				p.retryAt = time.Time{}
				p.record("lease_requested", map[string]any{"reasons": state.Reasons, "working": state.Working})
			}
		}
	}
	if p.lease != nil && !p.lease.exited() {
		state.State = "requested"
		switch {
		case !wanted:
			state.Text = both("任务已结束 · 稍后恢复系统休眠", "Tasks finished · Sleep resumes shortly")
		case hasPowerReason(state, "working") && hasPowerReason(state, "pluggedIn"):
			state.Text = both("运行任务中，已接通电源 · 正在阻止系统休眠", "Running tasks, plugged in · Preventing sleep")
		case hasPowerReason(state, "working"):
			state.Text = both("运行任务中 · 正在阻止系统休眠", "Running tasks · Preventing sleep")
		default:
			state.Text = both("已接通电源 · 正在阻止系统休眠", "Plugged in · Preventing sleep")
		}
	}
	switch {
	case wanted && (p.failed || p.lease == nil):
		state.State = "degraded"
		state.Text = both("无法阻止系统休眠；请检查设备服务日志，修复后重新开关电源设置", "Could not prevent sleep. Check the device-service log, then toggle the power setting after fixing the cause")
	case config.working && unknown:
		state.State = "degraded"
		state.Text = both("部分工作状态未确认；已有工作证据最多保留 90 秒，请检查设备连接和服务日志", "Some work status is unconfirmed. Existing evidence is kept for up to 90 seconds; check device connections and service logs")
	case config.plugged && p.source == "unknown":
		state.State = "degraded"
		state.Text = both("无法确认是否接通电源，“接通电源时始终阻止系统休眠”暂不生效；请检查设备服务日志", "Could not confirm external power, so “Always prevent sleep when plugged in” is inactive. Check the device-service log")
	}
	return p.setStatus(state)
}

func powerRetryDelay(attempt int) time.Duration {
	delays := [...]time.Duration{time.Second, 5 * time.Second, 15 * time.Second, 60 * time.Second}
	if attempt > len(delays) {
		attempt = len(delays)
	}
	return delays[attempt-1]
}

func hasPowerReason(state powerStatus, reason string) bool {
	for _, value := range state.Reasons {
		if value == reason {
			return true
		}
	}
	return false
}

func (p *powerController) record(event string, fields map[string]any) {
	if p.log != nil {
		p.log(event, fields)
	}
}
