//go:build !windows

package main

// 经控制通道装一个 harness：查版本、开始装、进度推给设备进程、install.read；装成后停用的写成启用，
// 然后照 harness.apply 重启它。npm 和注册表都是假的，放在这个 harness 自己的环境变量设置里。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestControlInstallsHarness(t *testing.T) {
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.10.0"}`))
	}))
	defer registry.Close()
	t.Setenv(registryEnvironment, registry.URL)
	_, _, control, stop := startManaged(t)
	defer stop()
	control.waitState("收到完整的状态", func(state controlState) bool {
		return state.harness("pi").State == stateRunning && state.harness("gemini").State == stateDisabled
	})
	root := t.TempDir()
	tools, bin := filepath.Join(root, "tools"), filepath.Join(root, "bin")
	writeScript(t, filepath.Join(tools, "npm"), `echo "npm $*"
printf '#!/bin/sh\necho 0.10.0\n' > '`+bin+`/gemini'
/bin/chmod +x '`+bin+`/gemini'
`)
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	path := tools + ":" + bin + ":/bin:/usr/bin"
	first, _ := control.latest()
	control.write(first.Snapshot.Version, edit(envKey("gemini"), []map[string]string{{"name": "PATH", "value": path}}))

	var versions struct {
		Harnesses []harnessVersionInfo `json:"harnesses"`
	}
	control.must("harness.versions", map[string]any{"latest": true}, &versions)
	var gemini harnessVersionInfo
	for _, info := range versions.Harnesses {
		if info.Harness == "gemini" {
			gemini = info
		}
	}
	if len(versions.Harnesses) != len(knownHarnesses) || gemini.Installed != nil || gemini.Latest == nil || *gemini.Latest != "0.10.0" {
		t.Fatalf("装之前的版本一览: %+v", gemini)
	}

	if _, failure := control.call("harness.install", map[string]any{"harness": "gemini", "version": "verified"}); failure == nil || failure.Reason != "invalid" || failure.Text.EN == "" {
		t.Fatalf("没有验证版时应被拒绝: %+v", failure)
	}
	var started struct {
		Job string `json:"job"`
	}
	control.must("harness.install", map[string]any{"harness": "gemini", "version": "latest"}, &started)
	var last installJob
	waitUntil(t, "安装任务结束并推过来", func() bool {
		control.mu.Lock()
		defer control.mu.Unlock()
		if len(control.installs) == 0 {
			return false
		}
		last = control.installs[len(control.installs)-1]
		return last.Job == started.Job && last.State != installRunning
	})
	if last.State != installSucceeded || last.Installed == nil || *last.Installed != "0.10.0" {
		t.Fatalf("应装成: %+v", last)
	}
	log := strings.Join(last.Log, "\n")
	if !strings.Contains(log, "npm install -g @google/gemini-cli@0.10.0") || !strings.Contains(log, enabledKey("gemini")) {
		t.Fatalf("日志里应有命令和写了启用的那一行:\n%s", log)
	}
	// 停用着的写成了启用，并且照 harness.apply 重启过：不再是“默认不启用”
	state := control.waitState("gemini 重新应用过", func(state controlState) bool {
		return state.harness("gemini").State != stateDisabled && state.harness("gemini").State != stateStarting
	})
	var enabled bool
	if raw, ok := state.Snapshot.Values[enabledKey("gemini")]; !ok || json.Unmarshal(mustJSON(t, raw), &enabled) != nil || !enabled {
		t.Fatalf("应写成启用: %+v", state.Snapshot.Values[enabledKey("gemini")])
	}
	var read struct {
		Jobs []installJob `json:"jobs"`
	}
	control.must("harness.install.read", map[string]any{}, &read)
	if len(read.Jobs) != 1 || read.Jobs[0].Job != started.Job || read.Jobs[0].State != installSucceeded {
		t.Fatalf("install.read: %+v", read.Jobs)
	}
	control.must("harness.versions", map[string]any{}, &versions)
	for _, info := range versions.Harnesses {
		if info.Harness == "gemini" && (info.Installed == nil || *info.Installed != "0.10.0" || info.Latest == nil) {
			t.Fatalf("装完重探版本，最新版给上次查到的: %+v", info)
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
