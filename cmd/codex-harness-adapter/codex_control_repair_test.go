package main

import (
	"context"
	"testing"
)

func TestCodexControlRepairOffer(t *testing.T) {
	text := both("启动失败："+codexPrivateDirectoryError, "Failed to start: "+codexPrivateDirectoryError)
	for _, item := range []struct {
		platform, id, state string
		text                *bilingual
		want                string
	}{
		{"windows", nativeCodex, stateStartFailed, &text, codexControlPermissions},
		{"darwin", nativeCodex, stateStartFailed, &text, ""},
		{"linux", nativeCodex, stateStartFailed, &text, ""},
		{"windows", "pi", stateStartFailed, &text, ""},
		{"windows", nativeCodex, stateRunning, &text, ""},
		{"windows", nativeCodex, stateStopped, &text, ""},
		{"windows", nativeCodex, stateStartFailed, nil, ""},
		{"windows", nativeCodex, stateStartFailed, &bilingual{EN: "other failure"}, ""},
	} {
		if got := codexControlRepairAction(item.platform, item.id, item.state, item.text); got != item.want {
			t.Fatalf("%+v: got %q", item, got)
		}
	}
}

func TestCodexControlRepairRejectsStaleState(t *testing.T) {
	c := settingsTestConfiguration(t)
	m := newHarnessManager(c)
	s := &controlServer{ctx: context.Background(), c: c, manager: m}
	for _, state := range []string{stateRunning, stateStarting, stateStopped, stateDisabled, stateStartFailed} {
		m.slots[nativeCodex].state = state
		before := m.slots[nativeCodex].round
		if _, failure := s.applyHarnessRepair(nativeCodex, codexControlPermissions); failure == nil || failure.Reason != "invalid" {
			t.Fatalf("%s 应拒绝: %+v", state, failure)
		}
		if m.slots[nativeCodex].round != before || m.slots[nativeCodex].state != state {
			t.Fatal("被拒绝的修复不应重启")
		}
	}
}
