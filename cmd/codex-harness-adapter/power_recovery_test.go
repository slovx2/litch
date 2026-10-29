package main

import (
	"testing"
	"time"
)

func TestPowerRestartIncompleteSnapshotPreservesEvidence(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity(powerActivitySource{ID: "a", Working: 1}, powerActivitySource{ID: "b", Working: 2})
	r.advance(20 * time.Second)
	state, err := r.p.activity(powerActivity{Generation: "restarted", Sequence: 1})
	if err != nil || state.State != "degraded" || state.Working != 3 {
		t.Fatalf("重启首份未知空摘要删除了旧证据: %+v %+v", state, err)
	}
	r.advance(20 * time.Second)
	state, err = r.p.activity(powerActivity{Generation: "restarted", Sequence: 2, Sources: []powerActivitySource{{ID: "a", Working: 0}}})
	if err != nil || state.Working != 2 {
		t.Fatalf("部分明确空闲不应清空其他来源: %+v %+v", state, err)
	}
	r.advance(49 * time.Second)
	if r.p.read().Working != 2 {
		t.Fatal("旧证据过早过期")
	}
	r.advance(time.Second)
	if r.p.read().Working != 0 || !r.backend.leases[len(r.backend.leases)-1].stopped {
		t.Fatal("未知摘要或重启刷新了旧证据期限")
	}
}

func TestPowerRestartCompleteEmptySnapshotReleasesWithGrace(t *testing.T) {
	r := newPowerTestRig(t)
	r.activity(powerActivitySource{ID: "a", Working: 1})
	r.advance(10 * time.Second)
	r.p.activity(powerActivity{Generation: "restarted", Sequence: 1})
	r.advance(10 * time.Second)
	state, err := r.p.activity(powerActivity{Generation: "restarted", Sequence: 2, Complete: true})
	if err != nil || state.Working != 0 || state.State != "requested" {
		t.Fatalf("完整空闲没有退出未知状态: %+v %+v", state, err)
	}
	r.advance(29 * time.Second)
	if r.backend.leases[0].stopped {
		t.Fatal("完整空闲没有保留30秒宽限")
	}
	r.advance(time.Second)
	if r.p.read().State != "inactive" || !r.backend.leases[0].stopped {
		t.Fatal("完整空闲确认后不应等到90秒")
	}
}
