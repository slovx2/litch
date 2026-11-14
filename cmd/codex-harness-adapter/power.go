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
	remotes                               map[string]*remotePowerEvidence
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
		retired: map[string]bool{}, evidence: map[string]powerEvidence{}, remotes: map[string]*remotePowerEvidence{}, source: "unknown"}
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
	if !validPowerActivity(value) {
		return p.rejectActivity()
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
	p.evidence = mergePowerEvidence(p.evidence, value, now)
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
	for _, remote := range p.remotes {
		if remote.owner != nil && remote.owner == owner {
			remote.owner, remote.disconnected = nil, true
		}
	}
	if p.owner != nil && p.owner == owner {
		p.owner, p.connectionLost = nil, true
	}
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
