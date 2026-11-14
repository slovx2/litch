package main

import (
	"testing"
	"time"
)

func remoteReport(sequence uint64, sources ...powerActivitySource) powerActivity {
	return powerActivity{Generation: "desktop-1", Sequence: sequence, Complete: true, Sources: sources}
}

func TestPowerRemoteDefaultOffAndIndependentSwitches(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity() // 已确认本机空闲。
	remote := powerActivitySource{ID: "remote-turn", Working: 1}
	if _, err := r.p.remoteActivity(remoteReport(1, remote), "desktop"); err != nil {
		t.Fatal(err)
	}
	if state := r.p.read(); state.State != "inactive" || state.Working != 0 || r.backend.starts != 0 {
		t.Fatalf("默认关闭仍被远程任务保活: %+v", state)
	}
	r.config.working, r.config.remote = false, true
	r.p.refresh()
	if state := r.p.read(); state.State != "requested" || state.Working != 1 || !hasPowerReason(state, "working") {
		t.Fatalf("远程开关依赖了本机任务开关: %+v", state)
	}
	r.config.remote = false
	r.p.refresh()
	if state := r.p.read(); state.State != "inactive" || !r.backend.leases[0].stopped {
		t.Fatalf("关闭远程选项未即时释放: %+v", state)
	}
}

func TestPowerRemoteDoesNotReplaceLocalEvidenceOrOwner(t *testing.T) {
	r := newPowerTestRig(t)
	r.config.remote = true
	r.p.activityFrom(powerActivity{Generation: "node", Sequence: 1, Complete: true, Sources: []powerActivitySource{{ID: "local", Working: 1}}}, "node-owner")
	r.p.remoteActivity(remoteReport(1, powerActivitySource{ID: "remote", Working: 1}), "desktop-owner")
	if r.p.read().Working != 2 {
		t.Fatal("两类证据未合并")
	}
	r.p.remoteActivity(remoteReport(2), "desktop-owner")
	r.p.disconnected("desktop-owner")
	if state := r.p.read(); state.Working != 1 || state.State != "requested" || r.p.connectionLost {
		t.Fatalf("桌面退出清除了本机任务或降级了本机连接: %+v", state)
	}
}

func TestPowerRemoteUnknownHeartbeatsCannotRenewEvidence(t *testing.T) {
	r := newPowerTestRig(t)
	r.config.working, r.config.remote = false, true
	r.activity()
	r.p.remoteActivity(remoteReport(1, powerActivitySource{ID: "remote", Working: 1}), "owner")
	r.advance(40 * time.Second)
	// 即使发送方错误地把未知项年龄改回 0，接收方也必须保留最初期限。
	r.p.remoteActivity(remoteReport(2, powerActivitySource{ID: "remote", Working: 1, Unknown: true}), "owner")
	r.advance(40 * time.Second)
	r.p.remoteActivity(remoteReport(3, powerActivitySource{ID: "remote", Working: 1, Unknown: true}), "owner")
	if r.p.read().Working != 1 {
		t.Fatal("未知宽限被提前清除")
	}
	r.advance(10 * time.Second)
	if state := r.p.read(); state.Working != 0 || state.State != "degraded" || !r.backend.leases[len(r.backend.leases)-1].stopped {
		t.Fatalf("未知心跳无限延长租约: %+v", state)
	}
}

func TestPowerRemoteDisconnectExpiresWithoutExtraGrace(t *testing.T) {
	r := newPowerTestRig(t)
	r.config.working, r.config.remote = false, true
	r.p.remoteActivity(remoteReport(1, powerActivitySource{ID: "remote", Working: 1}), "owner")
	r.advance(60 * time.Second)
	r.p.disconnected("owner")
	if r.p.read().State != "degraded" {
		t.Fatal("断线未降级")
	}
	r.advance(30 * time.Second)
	if state := r.p.read(); state.State != "inactive" || state.Working != 0 || !r.backend.leases[len(r.backend.leases)-1].stopped {
		t.Fatalf("断线后超过 90 秒仍保活: %+v", state)
	}
}

func TestPowerRemoteFinishedUsesOrdinaryGraceAndRejectsOutOfOrder(t *testing.T) {
	r := newPowerTestRig(t)
	r.config.working, r.config.remote = false, true
	working := remoteReport(1, powerActivitySource{ID: "remote", Working: 1})
	r.p.remoteActivity(working, "owner")
	r.p.remoteActivity(remoteReport(2), "owner")
	r.p.remoteActivity(working, "old-owner")
	if state := r.p.read(); state.Working != 0 || state.State != "requested" {
		t.Fatalf("迟到摘要恢复了已结束任务: %+v", state)
	}
	r.advance(30 * time.Second)
	if r.p.read().State != "inactive" {
		t.Fatal("正常结束没有释放")
	}
}

func TestPowerRemoteDoesNotRegisterAServiceAsLocal(t *testing.T) {
	r := newPowerTestRig(t)
	r.config.local, r.config.remote = false, true
	r.p.remoteActivity(remoteReport(1, powerActivitySource{ID: "remote", Working: 1}), "owner")
	if r.backend.starts != 0 {
		t.Fatal("远程证据绕过了本机服务登记")
	}
}
