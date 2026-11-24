//go:build !windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"
)

// 升级换版本走带 ifIdle 的启用：旧实例有回合在跑就不停它；只有客户端连着照停。
func TestAutostartIfIdleStopsOnlyAnIdleService(t *testing.T) {
	grace := deviceStopExitGrace
	deviceStopExitGrace = 50 * time.Millisecond
	t.Cleanup(func() { deviceStopExitGrace = grace })
	cfg, _, device, stop := startManaged(t)
	defer stop()
	answer := func(activity deviceActivity) {
		device.mu.Lock()
		defer device.mu.Unlock()
		device.activity = func() deviceActivity { return activity }
	}
	service, ok := readServiceStatus(cfg)
	if !ok || service.Service == nil {
		t.Fatal("夹具服务没有写出来历")
	}
	h := autostartHost{c: cfg}
	j := autostartJournal{StopPID: service.PID, StopSince: service.Service.StartedAt,
		Params: autostartParams{IfIdle: true, ResumeAfterRestart: true}}

	answer(deviceActivity{Turns: []string{"pi"}, Connections: 1})
	err := h.stopExisting(t.Context(), j)
	var busy *autostartBusyError
	if !errors.As(err, &busy) || !reflect.DeepEqual(busy.busy, []busyReason{
		{Reason: "activeTurns", Harnesses: []string{"pi"}}, {Reason: "clients", Count: 1},
	}) {
		t.Fatalf("有回合在跑时应当作罢并报原因：%v", err)
	}
	if !deviceLockHeld(cfg) || !canDial(cfg.deviceSocket()) {
		t.Fatal("作罢了却停了服务")
	}

	answer(deviceActivity{Connections: 2})
	if err := h.stopExisting(t.Context(), j); err != nil {
		t.Fatalf("只有客户端连着应当照停：%v", err)
	}
	if deviceLockHeld(cfg) || canDial(cfg.deviceSocket()) {
		t.Fatal("返回时服务还没有收干净")
	}
}

// 作罢时操作记录恢复成请求之前的样子，--wait 读到的是作罢的原因。
func TestAutostartDeferredRestoresTheJournal(t *testing.T) {
	f, backend := newAutoFake(t, "systemd")
	h := autostartHost{c: configuration{home: t.TempDir()}, spec: f.spec, backend: backend}
	before := &autostartOperation{OperationID: "earlier", Action: "enable", State: "completed"}
	repair := autoRepair("lingerUnavailable", "甲", "a")
	j := autostartJournal{
		Revision: 5, Registered: f.spec, Target: f.spec,
		Operation: &autostartOperation{OperationID: "swap", Action: "enable", State: "pending"},
		Previous:  before, PreviousRepair: repair, Expires: time.Now().Add(time.Minute),
		Hold: true,
	}
	if err := writeAutostartJournalForTest(h, j); err != nil {
		t.Fatal(err)
	}
	reasons := []busyReason{{Reason: "tasks", Count: 1}}
	_, err := h.changeJournal("swap", func(current *autostartJournal) {
		finishDeferred(current, "swap", reasons)
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := readAutostartJournal(h.c)
	if err != nil || got.Hold || got.Revision != 6 || !reflect.DeepEqual(got.Operation, before) ||
		!reflect.DeepEqual(got.Repair, repair) || got.Previous != nil ||
		got.Deferred == nil || got.Deferred.OperationID != "swap" || !reflect.DeepEqual(got.Deferred.Busy, reasons) {
		t.Fatalf("作罢后的日志不对：%+v, %v", got, err)
	}
	var out bytes.Buffer
	err = h.awaitOperation(t.Context(), "swap", json.NewEncoder(&out))
	var exit *exitError
	if !errors.As(err, &exit) || exit.code != exitServiceBusy {
		t.Fatalf("作罢应当以 4 退出：%v", err)
	}
	var result autostartWaitResult
	if json.Unmarshal(out.Bytes(), &result) != nil || result.State != "busy" || !reflect.DeepEqual(result.Busy, reasons) {
		t.Fatalf("--wait 的输出不对：%s", out.String())
	}
}

func writeAutostartJournalForTest(h autostartHost, j autostartJournal) error {
	if err := os.MkdirAll(h.c.deviceDirectory(), 0o700); err != nil {
		return err
	}
	return writeAutostartJournal(h.c, j)
}
