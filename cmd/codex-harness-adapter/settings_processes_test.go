package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// 可重连终端的四项：单独一组，中英文的标题和说明都有，带取值范围，立刻生效；范围之外的写入被拒绝并指出是哪一项。
func TestProcessSettingsAreDeclaredWithRanges(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	var group *settingGroup
	for index := range schema.Groups {
		if schema.Groups[index].ID == processGroup {
			group = &schema.Groups[index]
		}
	}
	if group == nil || group.Scope != deviceScope || group.Title.ZH == "" || group.Title.EN == "" || group.Description == nil || group.Description.ZH == "" || group.Description.EN == "" {
		t.Fatalf("可重连终端那一组没有声明全: %+v", group)
	}
	defaults := map[string]int{"processes.bufferBytes": 2097152, "processes.limit": 32, "processes.idleMs": 0, "processes.exitedMs": 600000}
	if len(processOptions) != len(defaults) {
		t.Fatalf("应有四项: %d", len(processOptions))
	}
	for _, option := range processOptions {
		spec, declared := schema.spec(option.key)
		if !declared || spec.Group != processGroup || spec.Type != settingInteger || spec.Scope != deviceScope || spec.Restart != restartNone {
			t.Fatalf("%s 没有照设备级的整数项声明: %+v", option.key, spec)
		}
		if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
			t.Fatalf("%s 缺中文或者英文的标题、说明", option.key)
		}
		want, known := defaults[option.key]
		if !known || spec.Default != want || spec.Minimum == nil || spec.Maximum == nil || *spec.Minimum > want || *spec.Maximum < want {
			t.Fatalf("%s 的默认值或者范围不对: %+v", option.key, spec)
		}
		for _, outside := range []int{*spec.Minimum - 1, *spec.Maximum + 1} {
			_, problem, err := cfg.settings.apply(0, []settingEdit{edit(option.key, outside)}, schema, cfg.validateSettings)
			if err != nil || problem == nil || problem.reason != "invalid" || problem.key != option.key {
				t.Fatalf("%s 写成 %d 应被拒绝: %+v %v", option.key, outside, problem, err)
			}
		}
		for _, wrong := range []any{"32", 1.5, true} {
			if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(option.key, wrong)}, schema, cfg.validateSettings); problem == nil || problem.key != option.key {
				t.Fatalf("%s 写成 %v 应被拒绝", option.key, wrong)
			}
		}
	}
}

// 拉起设备进程时带的参数取设置的现行值；手工把文件改到范围之外的那一项按默认值带，不让设备进程因为参数起不来。
func TestProcessSettingsBecomeDeviceArguments(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	if got := strings.Join(cfg.processArguments(), " "); got != "--process-buffer-bytes 2097152 --process-limit 32 --process-idle-ms 0 --process-exited-ms 600000" {
		t.Fatalf("没写过设置时应带默认值: %s", got)
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{
		edit("processes.bufferBytes", 65536), edit("processes.limit", 4), edit("processes.idleMs", 90000), edit("processes.exitedMs", 0),
	}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 4 {
		t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
	}
	if got := strings.Join(cfg.processArguments(), " "); got != "--process-buffer-bytes 65536 --process-limit 4 --process-idle-ms 90000 --process-exited-ms 0" {
		t.Fatalf("写过的设置没有带给设备进程: %s", got)
	}
	want := map[string]int{"bufferBytes": 65536, "maxProcesses": 4, "idleTimeoutMs": 90000, "exitedRetentionMs": 0}
	for field, value := range cfg.processLimits() {
		if want[field] != value || len(want) != 4 {
			t.Fatalf("推给设备进程的现行值不对: %v", cfg.processLimits())
		}
	}
	// 文件被手工改坏：范围之外的、不是整数的都按没写过算。
	data, _ := json.Marshal(settingsFile{Version: 2, Values: map[string]json.RawMessage{
		"processes.limit": json.RawMessage("99999"), "processes.bufferBytes": json.RawMessage(`"big"`), "processes.idleMs": json.RawMessage("-5"),
	}})
	if err := os.WriteFile(settingsPath(cfg.home), data, 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.settings = reloaded
	if got := strings.Join(cfg.processArguments(), " "); got != "--process-buffer-bytes 2097152 --process-limit 32 --process-idle-ms 0 --process-exited-ms 600000" {
		t.Fatalf("改坏了的值应按默认值带: %s", got)
	}
}
