package main

import (
	"encoding/json"
	"os"
	"testing"
)

// 定时任务的两项：单独一组、设备级、立刻生效，默认开、上限 2；推给设备进程的现行值跟着设置走，改坏了的按默认值。
func TestTaskSettingsAreDeclaredAndPushed(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	var group *settingGroup
	for index := range schema.Groups {
		if schema.Groups[index].ID == taskGroup {
			group = &schema.Groups[index]
		}
	}
	if group == nil || group.Scope != deviceScope || group.Title.ZH == "" || group.Title.EN == "" || group.Description == nil {
		t.Fatalf("定时任务那一组没有声明全: %+v", group)
	}
	enabled, declared := schema.spec(taskEnabledKey)
	if !declared || enabled.Type != settingBoolean || enabled.Default != true || enabled.Restart != restartNone || enabled.Scope != deviceScope {
		t.Fatalf("总开关声明得不对: %+v", enabled)
	}
	limit, declared := schema.spec(taskConcurrentKey)
	if !declared || limit.Type != settingInteger || limit.Default != 2 || limit.Restart != restartNone || limit.Minimum == nil || *limit.Minimum != 1 || limit.Maximum == nil {
		t.Fatalf("同时运行的上限声明得不对: %+v", limit)
	}
	for _, spec := range []settingSpec{enabled, limit} {
		if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
			t.Fatalf("%s 缺中文或者英文的标题、说明", spec.Key)
		}
	}
	if got := cfg.taskSettings(); got["enabled"] != true || got["maxConcurrent"] != 2 {
		t.Fatalf("没写过设置时应是默认值: %v", got)
	}
	for _, outside := range []int{0, *limit.Maximum + 1} {
		if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(taskConcurrentKey, outside)}, schema, cfg.validateSettings); problem == nil || problem.key != taskConcurrentKey {
			t.Fatalf("上限写成 %d 应被拒绝", outside)
		}
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{edit(taskEnabledKey, false), edit(taskConcurrentKey, 5)}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 2 {
		t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
	}
	if got := cfg.taskSettings(); got["enabled"] != false || got["maxConcurrent"] != 5 {
		t.Fatalf("写过的设置没有推给设备进程: %v", got)
	}
	// 文件被手工改坏：范围之外的按默认值。
	data, _ := json.Marshal(settingsFile{Version: 2, Values: map[string]json.RawMessage{taskConcurrentKey: json.RawMessage("999")}})
	if err := os.WriteFile(settingsPath(cfg.home), data, 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.settings = reloaded
	if got := cfg.taskSettings(); got["maxConcurrent"] != 2 || got["enabled"] != true {
		t.Fatalf("改坏了的值应按默认值: %v", got)
	}
}

// 审批等多久自动拒绝：设备级、立刻生效、默认 30 分钟、1 到 1440；推给设备进程，改坏了的按默认值。
func TestTaskApprovalTimeoutSetting(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	spec, declared := schema.spec(taskApprovalKey)
	if !declared || spec.Group != taskGroup || spec.Type != settingInteger || spec.Default != 30 || spec.Restart != restartNone || spec.Scope != deviceScope ||
		spec.Minimum == nil || *spec.Minimum != 1 || spec.Maximum == nil || *spec.Maximum != 1440 {
		t.Fatalf("审批时限声明得不对: %+v", spec)
	}
	if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
		t.Fatal("审批时限缺中文或者英文的标题、说明")
	}
	if got := cfg.taskSettings(); got["approvalTimeoutMinutes"] != 30 {
		t.Fatalf("没写过时应是 30: %v", got)
	}
	for _, outside := range []int{0, 1441} {
		if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(taskApprovalKey, outside)}, schema, cfg.validateSettings); problem == nil || problem.key != taskApprovalKey {
			t.Fatalf("写成 %d 应被拒绝", outside)
		}
	}
	if _, problem, err := cfg.settings.apply(0, []settingEdit{edit(taskApprovalKey, 5)}, schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	if got := cfg.taskSettings(); got["approvalTimeoutMinutes"] != 5 {
		t.Fatalf("写过的设置没有推给设备进程: %v", got)
	}
	data, _ := json.Marshal(settingsFile{Version: 2, Values: map[string]json.RawMessage{taskApprovalKey: json.RawMessage("99999")}})
	if err := os.WriteFile(settingsPath(cfg.home), data, 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.settings = reloaded
	if got := cfg.taskSettings(); got["approvalTimeoutMinutes"] != 30 {
		t.Fatalf("改坏了的值应按默认值: %v", got)
	}
}
