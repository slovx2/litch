package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHarnessCLISelectionAndRunningSnapshot(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	cfg.userEnv = map[string]string{"PI_CLI": "/isolated/env/pi"}
	entry := cfg.forHarness("pi")
	selected := selectedHarnessCLI(entry, "/isolated/env/pi", "0.99.1")
	if selected.Source != "environment" || selected.Version != "0.99.1" {
		t.Fatal(selected)
	}
	manager := newHarnessManager(cfg)
	selected.StartedAt = 1234
	manager.slots["pi"] = &harnessSlot{id: "pi", state: stateRunning, cli: selected}
	if _, problem, err := cfg.settings.apply(0, []settingEdit{edit(cliPathKey("pi"), "/isolated/settings/pi")}, manager.settingsSchema(), nil); err != nil || problem != nil {
		t.Fatalf("%v %v", err, problem)
	}
	for _, view := range manager.view(nil).Harnesses {
		if view.ID == "pi" && (view.CLI == nil || view.CLI.Path != selected.Path || view.CLI.Source != "environment" || view.CLI.StartedAt != 1234) {
			t.Fatalf("设置改了不能冒充已重启：%+v", view.CLI)
		}
	}
	if next := selectedHarnessCLI(cfg.forHarness("pi"), "/isolated/settings/pi", "0.99.1"); next.Source != "settings" {
		t.Fatal(next)
	}
	plain := settingsTestConfiguration(t).forHarness("pi")
	plain.userEnv = map[string]string{}
	if got := selectedHarnessCLI(plain, "/isolated/path/pi", "0.72.0"); got.Source != "path" {
		t.Fatal(got)
	}
}

func TestHarnessCLIFallbackIsNotUserEnvironment(t *testing.T) {
	cfg := settingsTestConfiguration(t).forHarness("opencode")
	home := t.TempDir()
	path := filepath.Join(home, ".opencode", "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	cfg.settingsEnv = map[string]string{"PATH": filepath.Join(home, "no-path"), "HOME": home, "CHA_OPENCODE_CLI": ""}
	if cfg.environmentValue("CHA_OPENCODE_CLI") != path {
		t.Fatal("未使用默认位置")
	}
	if got := selectedHarnessCLI(cfg, path, "1.18.33"); got.Source != "default" {
		t.Fatal(got)
	}
	cfg.settingsEnv["CHA_OPENCODE_CLI"] = path
	if got := selectedHarnessCLI(cfg, path, "1.18.33"); got.Source != "environment" {
		t.Fatal(got)
	}
}
