package sshtransport

import (
	"sync"
	"time"
)

// ConnectionPolicyObserver 把原生生命周期结果交给 JS；JS 暂停期间，Go 仍负责断开实际连接。
type ConnectionPolicyObserver interface {
	OnConnectionPolicy(state string)
}

type connectionPolicyState struct {
	Revision   int64 `json:"revision"`
	Background bool  `json:"background"`
	Suspended  bool  `json:"suspended"`
}

type backgroundPolicy struct {
	mu       sync.Mutex
	state    connectionPolicyState
	entered  time.Time
	timeout  time.Duration
	cancel   func()
	epoch    int64
	observer ConnectionPolicyObserver
	now      func() time.Time
	schedule func(time.Duration, func()) func()
	pause    func(bool)
}

func newBackgroundPolicy(pause func(bool)) *backgroundPolicy {
	return &backgroundPolicy{
		timeout: 10 * time.Minute,
		now:     time.Now,
		pause:   pause,
		schedule: func(delay time.Duration, run func()) func() {
			timer := time.AfterFunc(delay, run)
			return func() { timer.Stop() }
		},
	}
}

var mobileBackground = newBackgroundPolicy(setStreamsPaused)

// SetBackgroundTimeout 设置后台分钟数，0 表示从不。不是唤醒闹钟，冻结期间允许延迟。
func SetBackgroundTimeout(minutes int) {
	if minutes < 0 {
		return
	}
	mobileBackground.configure(time.Duration(minutes) * time.Minute)
}

func SetAppBackground(background bool) { mobileBackground.setBackground(background) }

func ConnectionPolicyState() string {
	mobileBackground.mu.Lock()
	defer mobileBackground.mu.Unlock()
	return mobileBackground.encoded()
}

func SetConnectionPolicyObserver(observer ConnectionPolicyObserver) {
	mobileBackground.mu.Lock()
	mobileBackground.observer = observer
	mobileBackground.mu.Unlock()
}

func (p *backgroundPolicy) encoded() string {
	text, _ := marshalJSON(p.state)
	return text
}

func (p *backgroundPolicy) cancelLocked() {
	p.epoch++
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
}

func (p *backgroundPolicy) armLocked() {
	p.cancelLocked()
	if !p.state.Background || p.state.Suspended || p.timeout == 0 {
		return
	}
	epoch := p.epoch
	remaining := p.timeout - p.now().Sub(p.entered)
	p.cancel = p.schedule(max(remaining, 0), func() {
		p.mu.Lock()
		if epoch != p.epoch || !p.state.Background || p.state.Suspended {
			p.mu.Unlock()
			return
		}
		p.state.Suspended = true
		p.state.Revision++
		p.pause(true)
		observer, state := p.observer, p.encoded()
		p.mu.Unlock()
		if observer != nil {
			observer.OnConnectionPolicy(state)
		}
	})
}

func (p *backgroundPolicy) configure(timeout time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.timeout = timeout
	p.armLocked()
}

func (p *backgroundPolicy) setBackground(background bool) {
	p.mu.Lock()
	if p.state.Background == background {
		p.mu.Unlock()
		return
	}
	p.state.Background = background
	p.state.Revision++
	if background {
		p.entered = p.now()
		p.armLocked()
	} else {
		// 回前台只取消，不按过去经过的时间补断健康连接。
		p.cancelLocked()
		p.state.Suspended = false
		p.pause(false)
	}
	observer, state := p.observer, p.encoded()
	p.mu.Unlock()
	if observer != nil {
		observer.OnConnectionPolicy(state)
	}
}
