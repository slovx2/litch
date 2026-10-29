package main

import (
	"context"
	"reflect"
	"sync"
	"time"
)

const (
	powerEvidenceTTL  = 90 * time.Second
	powerReleaseGrace = 30 * time.Second
	powerLeaseRenew   = 60 * time.Second
	powerSourcePoll   = 15 * time.Second
)

// requested 表示请求已提交且子进程仍在；不宣称测量了内核断言或能覆盖合盖睡眠。
type powerStatus struct {
	Supported                 bool      `json:"supported"`
	ConfiguredForLocalService bool      `json:"configuredForLocalService"`
	State                     string    `json:"state"`
	Reasons                   []string  `json:"reasons"`
	PowerSource               string    `json:"powerSource"`
	Working                   int       `json:"working"`
	Text                      bilingual `json:"text"`
}

type powerActivitySource struct {
	ID            string `json:"id"`
	Working       int    `json:"working"`
	ObservedAgoMs int64  `json:"observedAgoMs"`
	Unknown       bool   `json:"unknown"`
}
type powerActivity struct {
	Generation string                `json:"generation"`
	Sequence   uint64                `json:"sequence"`
	Complete   bool                  `json:"complete"`
	Sources    []powerActivitySource `json:"sources"`
}
type powerEvidence struct {
	working  int
	observed time.Time
	unknown  bool
}
type powerLease interface {
	stop()
	exited() bool
}
type powerBackend interface {
	supported() bool
	start(context.Context) (powerLease, error)
	source(context.Context) (string, error)
}

type powerController struct {
	mu                                    sync.Mutex
	ctx                                   context.Context
	backend                               powerBackend
	settings                              func() powerSettings
	changed                               func()
	log                                   func(string, map[string]any)
	now                                   func() time.Time
	status                                powerStatus
	generation                            string
	sequence                              uint64
	lastActivity                          time.Time
	lastComplete                          bool
	retired                               map[string]bool
	evidence                              map[string]powerEvidence
	lastSettings                          powerSettings
	lease                                 powerLease
	renewAt, releaseAt, retryAt, sourceAt time.Time
	source                                string
	failures                              int
	failed                                bool
	invalidActivity                       bool
	owner                                 any
	connectionLost                        bool
	closed                                bool
	done                                  chan struct{}
}

func newPowerController(ctx context.Context, backend powerBackend, settings func() powerSettings, changed func(), log func(string, map[string]any)) *powerController {
	p := &powerController{ctx: ctx, backend: backend, settings: settings, changed: changed, log: log, now: time.Now,
		retired: map[string]bool{}, evidence: map[string]powerEvidence{}, source: "unknown"}
	p.status = powerStatus{Supported: backend.supported(), State: "inactive", PowerSource: "unknown", Reasons: []string{}}
	return p
}

func (p *powerController) run() {
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		p.refresh()
		for {
			select {
			case <-p.ctx.Done():
				p.close()
				return
			case <-ticker.C:
				p.refresh()
			}
		}
	}()
}

func (p *powerController) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.release()
}

func (p *powerController) read() powerStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.status
	state.Reasons = append([]string{}, state.Reasons...)
	return state
}

func (p *powerController) refresh() {
	p.mu.Lock()
	changed := p.reconcile()
	p.mu.Unlock()
	if changed && p.changed != nil {
		p.changed()
	}
}

func (p *powerController) activity(value powerActivity) (powerStatus, *controlError) {
	return p.activityFrom(value, nil)
}

func (p *powerController) activityFrom(value powerActivity, owner any) (powerStatus, *controlError) {
	if len(value.Generation) == 0 || len(value.Generation) > 128 || len(value.Sources) > 16384 || value.Sequence > 9007199254740991 {
		return p.rejectActivity()
	}
	seen := map[string]bool{}
	for _, source := range value.Sources {
		if source.ID == "" || len(source.ID) > 128 || seen[source.ID] || source.Working < 0 || source.Working > 1000000 || source.ObservedAgoMs < 0 || source.ObservedAgoMs > int64(365*24*time.Hour/time.Millisecond) {
			return p.rejectActivity()
		}
		seen[source.ID] = true
	}
	p.mu.Lock()
	if p.closed || p.retired[value.Generation] || (p.generation == value.Generation && value.Sequence <= p.sequence) {
		p.mu.Unlock()
		return p.read(), nil
	}
	if p.generation != "" && p.generation != value.Generation {
		p.retired[p.generation] = true
	}
	p.generation, p.sequence = value.Generation, value.Sequence
	p.invalidActivity = false
	p.owner, p.connectionLost = owner, false
	now := p.now()
	p.lastActivity = now
	p.lastComplete = value.Complete
	next := make(map[string]powerEvidence, len(value.Sources))
	// 重启或部分查询失败时，省略项不代表已空闲；沿用旧证据的原始期限。
	if !value.Complete {
		for id, old := range p.evidence {
			old.unknown = true
			next[id] = old
		}
	}
	for _, source := range value.Sources {
		entry := powerEvidence{working: source.Working, observed: now.Add(-time.Duration(source.ObservedAgoMs) * time.Millisecond), unknown: source.Unknown}
		// unknown 不能把旧证据重新盖成新鲜，也不能把上一轮已知工作误报为空闲。
		if old, ok := p.evidence[source.ID]; ok && source.Unknown {
			entry.working = old.working
			if old.observed.Before(entry.observed) {
				entry.observed = old.observed
			}
		}
		next[source.ID] = entry
	}
	p.evidence = next
	changed := p.reconcile()
	p.mu.Unlock()
	if changed && p.changed != nil {
		p.changed()
	}
	return p.read(), nil
}

// 只有发送过当前活动摘要的连接断开才降级；设置 CLI 的短连接不影响工作。
func (p *powerController) disconnected(owner any) {
	p.mu.Lock()
	if p.owner == nil || p.owner != owner {
		p.mu.Unlock()
		return
	}
	p.owner, p.connectionLost = nil, true
	changed := p.reconcile()
	p.mu.Unlock()
	if changed && p.changed != nil {
		p.changed()
	}
}

func invalidPowerActivity() *controlError {
	return &controlError{Reason: "invalid", Text: both("电源活动摘要无效", "The power activity summary is invalid")}
}

func (p *powerController) rejectActivity() (powerStatus, *controlError) {
	p.mu.Lock()
	p.invalidActivity = true
	changed := p.reconcile()
	p.mu.Unlock()
	if changed && p.changed != nil {
		p.changed()
	}
	return p.read(), invalidPowerActivity()
}

func (p *powerController) release() {
	if p.lease != nil {
		p.lease.stop()
		p.lease = nil
	}
	p.releaseAt, p.renewAt = time.Time{}, time.Time{}
}

func (p *powerController) setStatus(state powerStatus) bool {
	if reflect.DeepEqual(p.status, state) {
		return false
	}
	p.status = state
	return true
}
