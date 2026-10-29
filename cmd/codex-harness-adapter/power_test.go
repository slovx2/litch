package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

type fakePowerLease struct {
	dead    bool
	stopped bool
}

func (l *fakePowerLease) stop()        { l.dead = true; l.stopped = true }
func (l *fakePowerLease) exited() bool { return l.dead }

type fakePowerBackend struct {
	available      bool
	power          string
	fail           bool
	starts, probes int
	leases         []*fakePowerLease
	beforeStart    func()
}

func (b *fakePowerBackend) supported() bool                        { return b.available }
func (b *fakePowerBackend) source(context.Context) (string, error) { b.probes++; return b.power, nil }
func (b *fakePowerBackend) start(context.Context) (powerLease, error) {
	b.starts++
	if b.beforeStart != nil {
		b.beforeStart()
	}
	if b.fail {
		return nil, errors.New("injected spawn failure")
	}
	l := &fakePowerLease{}
	b.leases = append(b.leases, l)
	return l, nil
}

type powerTestRig struct {
	t        *testing.T
	p        *powerController
	backend  *fakePowerBackend
	config   powerSettings
	now      time.Time
	sequence uint64
	changes  int
}

func newPowerTestRig(t *testing.T) *powerTestRig {
	t.Helper()
	r := &powerTestRig{t: t, backend: &fakePowerBackend{available: true, power: "ac"}, config: powerSettings{local: true, working: true}, now: time.Now()}
	r.p = newPowerController(context.Background(), r.backend, func() powerSettings { return r.config }, func() { r.changes++ }, nil)
	r.p.now = func() time.Time { return r.now }
	t.Cleanup(r.p.close)
	return r
}
func (r *powerTestRig) advance(d time.Duration) { r.now = r.now.Add(d); r.p.refresh() }
func (r *powerTestRig) activity(sources ...powerActivitySource) powerStatus {
	r.sequence++
	state, err := r.p.activity(powerActivity{Generation: "node-1", Sequence: r.sequence, Complete: true, Sources: sources})
	if err != nil {
		r.t.Fatal(err)
	}
	return state
}
func TestPowerWorkingOverlapGraceAndSettings(t *testing.T) {
	r := newPowerTestRig(t)
	state := r.activity(powerActivitySource{ID: "a", Working: 1}, powerActivitySource{ID: "b", Working: 1})
	if state.State != "requested" || state.Working != 2 || r.backend.starts != 1 {
		t.Fatalf("没有申请共享租约: %+v", state)
	}
	r.advance(10 * time.Second)
	r.activity(powerActivitySource{ID: "b", Working: 1})
	if r.backend.leases[0].stopped {
		t.Fatal("仍有工作时释放了租约")
	}
	r.activity()
	r.advance(29 * time.Second)
	if r.p.read().State != "requested" {
		t.Fatal("正常结束过早释放")
	}
	r.advance(time.Second)
	if r.p.read().State != "inactive" || !r.backend.leases[0].stopped {
		t.Fatal("宽限结束没有释放")
	}
	r.activity(powerActivitySource{ID: "c", Working: 1})
	r.config.working = false
	r.p.refresh()
	if r.p.read().State != "inactive" || !r.backend.leases[1].stopped {
		t.Fatal("关闭设置未立即释放")
	}
}
func TestPowerUnknownCannotRefreshEvidence(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity(powerActivitySource{ID: "old", Working: 1})
	r.advance(60 * time.Second)
	state := r.activity(powerActivitySource{ID: "old", Working: 0, Unknown: true}, powerActivitySource{ID: "new", Working: 1})
	if state.Working != 2 || state.State != "degraded" {
		t.Fatalf("未知抹掉旧工作: %+v", state)
	}
	r.advance(29 * time.Second)
	r.activity(powerActivitySource{ID: "old", Working: 1, Unknown: true}, powerActivitySource{ID: "new", Working: 1})
	r.advance(time.Second)
	if r.p.read().Working != 1 {
		t.Fatalf("心跳或其他来源刷新了旧证据: %+v", r.p.read())
	}
	r.activity(powerActivitySource{ID: "old", Working: 1, Unknown: true})
	if r.p.read().State != "degraded" || !r.backend.leases[len(r.backend.leases)-1].stopped {
		t.Fatal("过期后不应再加 30 秒")
	}
}
func TestPowerObservedAgeAndDisconnectExpiry(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity(powerActivitySource{ID: "a", Working: 1, ObservedAgoMs: 80000})
	r.advance(9 * time.Second)
	r.activity(powerActivitySource{ID: "a", Working: 1, ObservedAgoMs: 89000})
	r.advance(time.Second)
	if r.p.read().Working != 0 || r.p.read().State != "degraded" || !r.backend.leases[0].stopped {
		t.Fatal("observedAgoMs 未按真实证据衰减")
	}
	r.activity(powerActivitySource{ID: "a", Working: 1})
	r.advance(90 * time.Second)
	if r.p.read().Working != 0 || !r.backend.leases[len(r.backend.leases)-1].stopped {
		t.Fatal("控制通道断开后仍无限保持")
	}
}

func TestPowerOnlyActivityOwnerDisconnectDegrades(t *testing.T) {
	r := newPowerTestRig(t)
	r.p.activityFrom(powerActivity{Generation: "node-1", Sequence: 1, Complete: true, Sources: []powerActivitySource{{ID: "a", Working: 1}}}, "node-connection")
	r.p.disconnected("settings-cli")
	if r.p.read().State != "requested" {
		t.Fatal("无关连接断开影响活动证据")
	}
	r.advance(20 * time.Second)
	r.p.disconnected("node-connection")
	if r.p.read().State != "degraded" || r.backend.leases[0].stopped {
		t.Fatal("活动连接断开应降级但暂存证据")
	}
	r.advance(70 * time.Second)
	if r.p.read().Working != 0 || !r.backend.leases[len(r.backend.leases)-1].stopped {
		t.Fatal("断线时重新计算了 90 秒期限")
	}
}
func TestPowerGenerationAndSequence(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity(powerActivitySource{ID: "a", Working: 1})
	r.p.activity(powerActivity{Generation: "node-1", Sequence: 0, Sources: nil})
	if r.p.read().Working != 1 {
		t.Fatal("旧序号覆盖新活动")
	}
	r.p.activity(powerActivity{Generation: "node-2", Sequence: 1, Complete: true, Sources: []powerActivitySource{{ID: "b", Working: 2}}})
	r.p.activity(powerActivity{Generation: "node-1", Sequence: 99, Sources: nil})
	if r.p.read().Working != 2 {
		t.Fatal("退役代覆盖新进程")
	}
}
func TestPowerACOnlyAndUnsupportedIsolation(t *testing.T) {
	r := newPowerTestRig(t)
	r.config = powerSettings{local: true, plugged: true}
	r.activity()
	if r.p.read().State != "requested" || !hasPowerReason(r.p.read(), "pluggedIn") {
		t.Fatal("接电常开未生效")
	}
	r.backend.power = "battery"
	r.advance(15 * time.Second)
	if !r.backend.leases[0].stopped || r.p.read().State != "inactive" {
		t.Fatal("拔电没有立即撤销来源")
	}
	r.backend.power = "unknown"
	r.advance(15 * time.Second)
	if r.p.read().State != "degraded" || r.backend.starts != 1 {
		t.Fatal("未知供电不应当作接电")
	}
	for _, supported := range []bool{true, false} {
		r2 := newPowerTestRig(t)
		r2.backend.available = supported
		r2.config.local = false
		r2.activity(powerActivitySource{ID: "remote", Working: 1})
		if r2.backend.starts != 0 || r2.backend.probes != 0 {
			t.Fatal("未登记服务触碰了系统电源")
		}
		if !supported && r2.p.read().State != "unsupported" {
			t.Fatal("不支持平台谎报能力")
		}
	}
}
func TestPowerRenewalAndFailureRetry(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity(powerActivitySource{ID: "a", Working: 1})
	old := r.backend.leases[0]
	r.backend.beforeStart = func() {
		if old.stopped {
			t.Fatal("新租约建立前关闭旧租约")
		}
	}
	r.advance(60 * time.Second)
	if r.backend.starts != 2 || !old.stopped {
		t.Fatal("没有在 60 秒提前续租")
	}
	r.backend.beforeStart = nil
	r.p.close()
	if !r.backend.leases[1].stopped {
		t.Fatal("关闭服务没有回收租约")
	}
	r2 := newPowerTestRig(t)
	r2.backend.fail = true
	r2.activity(powerActivitySource{ID: "a", Working: 1})
	for _, d := range []time.Duration{time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second} {
		r2.advance(d)
	}
	if r2.backend.starts != 4 || r2.p.read().State != "degraded" {
		t.Fatalf("失败未有限退避: %d %+v", r2.backend.starts, r2.p.read())
	}
	r2.backend.fail = false
	r2.config.working = false
	r2.p.refresh()
	r2.config.working = true
	r2.p.refresh()
	if r2.p.read().State != "requested" {
		t.Fatal("修复后重开设置没有恢复")
	}
}
func TestPowerActivityLargeSnapshotAndRejectOverflow(t *testing.T) {
	r := newPowerTestRig(t)
	sources := make([]powerActivitySource, 16384)
	for i := range sources {
		sources[i] = powerActivitySource{ID: fmt.Sprint(i), Working: 1}
	}
	if got := r.activity(sources...); got.Working != 16384 {
		t.Fatal("完整活动清单被截断")
	}
	_, err := r.p.activity(powerActivity{Generation: "node-1", Sequence: 2, Sources: append(sources, powerActivitySource{ID: "extra"})})
	if err == nil || r.p.read().State != "degraded" || r.p.read().Working != 16384 {
		t.Fatal("超量没有明确降级并保留旧证据")
	}
}
func TestParsePowerSource(t *testing.T) {
	for input, want := range map[string]string{
		"Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged":         "ac",
		"Now drawing from 'AC Power'\n":                                          "ac",
		"Now drawing from 'Battery Power'\n -InternalBattery-0 85%; discharging": "battery",
		"Now drawing from 'UPS Power'":                                           "unknown",
		"Battery Power appears in a warning":                                     "unknown",
		"":                                                                       "unknown",
	} {
		if got := parsePowerSource(input); got != want {
			t.Fatalf("%q: %s want %s", input, got, want)
		}
	}
}

func TestPowerRequestedTextExplainsReasons(t *testing.T) {
	for _, item := range []struct {
		name    string
		working int
		plugged bool
	}{
		{"working", 1, false},
		{"pluggedIn", 0, true},
		{"both", 1, true},
	} {
		t.Run(item.name, func(t *testing.T) {
			r := newPowerTestRig(t)
			r.config.plugged = item.plugged
			state := r.activity(powerActivitySource{ID: "thread", Working: item.working})
			if state.State != "requested" || !strings.Contains(state.Text.ZH, "正在阻止系统休眠") || !strings.Contains(state.Text.EN, "Preventing sleep") {
				t.Fatalf("状态文案必须说明正在阻止休眠: %+v", state)
			}
			if strings.Contains(state.Text.ZH, "运行任务中") != (item.working > 0) || strings.Contains(state.Text.EN, "Running tasks") != (item.working > 0) || strings.Contains(state.Text.ZH, "接通电源") != item.plugged || strings.Contains(strings.ToLower(state.Text.EN), "plugged in") != item.plugged {
				t.Fatalf("文案没有准确反映生效来源: %+v", state)
			}
		})
	}
	r := newPowerTestRig(t)
	r.backend.fail = true
	state := r.activity(powerActivitySource{ID: "thread", Working: 1})
	if state.State != "degraded" || !strings.Contains(state.Text.ZH, "请检查设备服务日志") || !strings.Contains(state.Text.EN, "Check the device-service log") {
		t.Fatalf("来源文案不应盖过可操作的失败提示: %+v", state)
	}
}
