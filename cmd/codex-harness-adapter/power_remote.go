package main

import "time"

type remotePowerEvidence struct {
	sequence     uint64
	owner        any
	disconnected bool
	last         time.Time
	evidence     map[string]powerEvidence
}

func validPowerActivity(value powerActivity) bool {
	if len(value.Generation) == 0 || len(value.Generation) > 128 || len(value.Sources) > 16384 || value.Sequence > 9007199254740991 {
		return false
	}
	seen := map[string]bool{}
	for _, source := range value.Sources {
		if source.ID == "" || len(source.ID) > 128 || seen[source.ID] || source.Working < 0 || source.Working > 1000000 || source.ObservedAgoMs < 0 || source.ObservedAgoMs > int64(365*24*time.Hour/time.Millisecond) {
			return false
		}
		seen[source.ID] = true
	}
	return true
}

// 本机与远程使用同一份证据合并规则；未知、遗漏和断线均不能刷新旧证据的期限。
func mergePowerEvidence(previous map[string]powerEvidence, value powerActivity, now time.Time) map[string]powerEvidence {
	next := make(map[string]powerEvidence, len(value.Sources))
	if !value.Complete {
		for id, old := range previous {
			old.unknown = true
			next[id] = old
		}
	}
	for _, source := range value.Sources {
		entry := powerEvidence{working: source.Working, observed: now.Add(-time.Duration(source.ObservedAgoMs) * time.Millisecond), unknown: source.Unknown}
		if old, ok := previous[source.ID]; ok && source.Unknown {
			entry.working = old.working
			if old.observed.Before(entry.observed) {
				entry.observed = old.observed
			}
		}
		next[source.ID] = entry
	}
	return next
}

// 仅由桌面进程直连本机控制套接字，不经设备协议接受远端客户端的保活请求。
// 与 Node 的本机摘要分表；桌面断开不影响本机任务，桌面重连也不能接管它。
func (p *powerController) remoteActivity(value powerActivity, owner any) (powerStatus, *controlError) {
	if !validPowerActivity(value) {
		return p.read(), invalidPowerActivity()
	}
	p.mu.Lock()
	remote := p.remotes[value.Generation]
	if p.closed || (remote != nil && value.Sequence <= remote.sequence) {
		p.mu.Unlock()
		return p.read(), nil
	}
	if remote == nil {
		if len(p.remotes) >= 128 {
			p.mu.Unlock()
			return p.read(), invalidPowerActivity()
		}
		remote = &remotePowerEvidence{}
		p.remotes[value.Generation] = remote
	}
	remote.sequence, remote.owner, remote.disconnected = value.Sequence, owner, false
	remote.last = p.now()
	remote.evidence = mergePowerEvidence(remote.evidence, value, remote.last)
	changed := p.reconcile()
	p.mu.Unlock()
	if changed && p.changed != nil {
		p.changed()
	}
	return p.read(), nil
}

func (p *powerController) remoteWorking(now time.Time) (working int, unknown, expired bool) {
	for id, remote := range p.remotes {
		if now.Sub(remote.last) >= powerEvidenceTTL {
			delete(p.remotes, id)
			for _, evidence := range remote.evidence {
				expired = expired || evidence.working > 0
			}
			continue
		}
		for _, evidence := range remote.evidence {
			stale := now.Sub(evidence.observed) >= powerEvidenceTTL
			unknown = unknown || evidence.unknown || stale || (remote.disconnected && evidence.working > 0)
			if stale {
				expired = expired || evidence.working > 0
			} else {
				working += evidence.working
			}
		}
	}
	return
}
