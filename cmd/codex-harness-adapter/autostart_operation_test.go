package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func autoTestParams(operation string, rev int64) autostartParams {
	return autostartParams{OperationID: operation, ExpectedRevision: &rev}
}

func TestAutostartDisableWaitsForReplyThenPreservesLinger(t *testing.T) {
	f, backend := newAutoFake(t, "systemd")
	h := autostartHost{c: configuration{home: t.TempDir()}, spec: f.spec, backend: backend}
	ctx := t.Context()
	if err := os.Mkdir(h.c.deviceDirectory(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeAutostartJournal(h.c, autostartJournal{Revision: 2, Registered: h.spec}); err != nil {
		t.Fatal(err)
	}
	if err := backend.install(ctx, h.spec, backend.inspect(ctx, h.spec)); err != nil {
		t.Fatal(err)
	}
	f.active, f.lingering = false, true
	params := autoTestParams("disable", 2)
	pending, failure := h.queue(ctx, "disable", params)
	if failure != nil || pending.(autostartMutationResult).State != "accepted" {
		t.Fatalf("排队：%+v, %+v", pending, failure)
	}
	again, failure := h.queue(ctx, "disable", params)
	if failure != nil || again.(autostartMutationResult).OperationID != "disable" {
		t.Fatalf("重试同一操作：%+v, %+v", again, failure)
	}
	record, err := readAutostartJournal(h.c)
	if err != nil || !record.pending() || record.Released || record.Hold || record.Revision != 3 {
		t.Fatalf("回复前不应许可改变登记：%+v, %v", record, err)
	}
	if _, err := os.Stat(f.loadPath); err != nil {
		t.Fatalf("回复前改动了登记: %v", err)
	}
	if _, failure := h.queue(ctx, "disable", autoTestParams("different", 2)); failure == nil || failure.Reason != "conflict" {
		t.Fatalf("接受旧版本：%+v", failure)
	}
	if err := h.release(ctx, params.OperationID); err != nil {
		t.Fatal(err)
	}
	if err := h.runWorker(ctx, 3); err != nil {
		t.Fatal(err)
	}
	got, err := h.get(ctx)
	if err != nil || got.State != "disabled" || got.Linger != "enabled" || got.RequiresLogin ||
		got.LastOperation == nil || got.LastOperation.State != "completed" || got.Revision != 4 {
		t.Fatalf("完成后的系统状态：%+v, %v", got, err)
	}
	if _, err := os.Stat(autostartJournalPath(h.c)); err != nil {
		t.Fatalf("关闭删除了设备状态: %v", err)
	}
}

func TestAutostartManualTakeoverRequiresTwoChoices(t *testing.T) {
	f, backend := newAutoFake(t, "systemd")
	home := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	c := configuration{home: home, root: home, node: exe, detached: true}
	f.spec.Executable, f.spec.Node, f.spec.Root, f.spec.Home = exe, exe, home, home
	h := autostartHost{c: c, spec: f.spec, backend: backend}
	device := openDeviceService(c)
	defer device.release()
	if device.lock == nil {
		t.Fatal("夹具没有拿到设备锁")
	}
	status, err := h.get(t.Context())
	if err != nil || status.State != "disabled" || status.Instance == nil || status.Instance.Mode != "manual" {
		t.Fatalf("手动实例：%+v, %v", status, err)
	}
	params := autoTestParams("enable", 0)
	if _, failure := h.queue(t.Context(), "enable", params); failure == nil || failure.Reason != "conflict" {
		t.Fatalf("未确认接管却通过：%+v", failure)
	}
	params.Takeover = true
	if _, failure := h.queue(t.Context(), "enable", params); failure == nil || failure.Reason != "busy" {
		t.Fatalf("未确认停止却通过：%+v", failure)
	}
	params.ConfirmStop = true
	device.facts.Detached = false
	device.report("ready", "", nil)
	if _, failure := h.queue(t.Context(), "enable", params); failure == nil || failure.Reason != "conflict" {
		t.Fatalf("接管了归属不明的前台服务：%+v", failure)
	}
	device.facts.Detached = true
	device.report("ready", "", nil)
	got, failure := h.queue(t.Context(), "enable", params)
	if failure != nil || got.(autostartMutationResult).Reconnect == nil || !*got.(autostartMutationResult).Reconnect {
		t.Fatalf("未报告确认停机后需重连：%+v, %+v", got, failure)
	}
	// 模拟应答未交给系统，助手超时后不停止设备。
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err := h.runWorker(ctx, 1); err != nil {
		t.Fatal(err)
	}
	status, err = h.get(t.Context())
	if err != nil || status.Instance == nil || status.Instance.Mode != "manual" ||
		status.LastOperation == nil || status.LastOperation.State != "failed" {
		t.Fatalf("未发出应答却动了已有实例或未记录失败：%+v, %v", status, err)
	}
}

func TestAutostartReadinessIsReadOnly(t *testing.T) {
	_, backend := newAutoFake(t, "systemd")
	base := t.TempDir()
	h := autostartHost{c: configuration{home: base}, spec: autostartSpec{ID: "com.litch.fixture"}, backend: backend}
	result, err := h.readiness(t.Context())
	if err != nil || result.State != "notReady" || result.Repair == nil || result.Repair.Code != "notRegistered" {
		t.Fatalf("未注册时的只读探针：%+v, %v", result, err)
	}
	if fi, err := os.Stat(filepath.Join(base, "device")); fi != nil || !os.IsNotExist(err) {
		t.Fatalf("探针创建了设备目录: %v, %v", fi, err)
	}
}

func TestAutostartMutationValidation(t *testing.T) {
	for _, raw := range []string{
		`{}`, `{"operationId":"x","expectedRevision":-1}`, `{"operationId":"x","expectedRevision":null}`,
		`{"operationId":"x","expectedRevision":0,"allowLinger":true}`,
		`{"operationId":"x","expectedRevision":0,"confirmStop":null}`,
		`{"operationId":"x","expectedRevision":0,"confirmed":true}`,
	} {
		if _, failure := decodeAutostartParams(json.RawMessage(raw), false); failure == nil {
			t.Errorf("错误接受 %s", raw)
		}
	}
}
