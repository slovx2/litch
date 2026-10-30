package main

import (
	"encoding/json"
	"testing"
)

// 留存走通用设置持久化，拒绝自由天数与错误类型。
func TestSuggestionRetentionSetting(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	key := "sessions.suggestionRetentionDays"
	spec, ok := schema.spec(key)
	if !ok || spec.Type != settingEnum || spec.Default != "7" || spec.Scope != deviceScope || spec.Restart != restartNone || len(spec.Options) != 6 {
		t.Fatalf("建议留存声明不完整: %+v", spec)
	}
	for _, value := range []any{"2", "0", 7} {
		if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(key, value)}, schema, cfg.validateSettings); problem == nil {
			t.Fatalf("不应接受留存值: %v", value)
		}
	}
	_, problem, err := cfg.settings.apply(0, []settingEdit{edit(key, "never")}, schema, cfg.validateSettings)
	if problem != nil || err != nil {
		t.Fatalf("保存不过期失败: %+v %v", problem, err)
	}
	if raw, written := cfg.settings.lookup(key); !written || string(raw) != `"never"` {
		t.Fatalf("未持久化: %s", raw)
	}
}

// 会话编排的开关：单独一组、设备级的布尔项、默认开、立刻生效；写错类型被拒绝，写成关能写进去。
func TestSessionTreeSettingIsDeclared(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	var group *settingGroup
	for index := range schema.Groups {
		if schema.Groups[index].ID == sessionGroup {
			group = &schema.Groups[index]
		}
	}
	if group == nil || group.Scope != deviceScope || group.Title.ZH == "" || group.Title.EN == "" || group.Description == nil {
		t.Fatalf("会话编排那一组没有声明全: %+v", group)
	}
	spec, declared := schema.spec(sessionTreeKey)
	if !declared || spec.Group != sessionGroup || spec.Type != settingBoolean || spec.Scope != deviceScope || spec.Restart != restartNone || spec.Default != true {
		t.Fatalf("会话编排的开关没有照设备级、默认开的布尔项声明: %+v", spec)
	}
	if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
		t.Fatal("会话编排的开关缺中文或者英文的标题、说明")
	}
	if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(sessionTreeKey, "off")}, schema, cfg.validateSettings); problem == nil || problem.key != sessionTreeKey {
		t.Fatalf("写成字符串应被拒绝: %+v", problem)
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{edit(sessionTreeKey, false)}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 1 {
		t.Fatalf("写成关应该能写进去: %v %+v %v", changed, problem, err)
	}
	if raw, written := cfg.settings.lookup(sessionTreeKey); !written || string(raw) != string(json.RawMessage("false")) {
		t.Fatalf("写进去的值不对: %s %v", raw, written)
	}
}

// 提醒收尾的开关：同一组、设备级的布尔项、默认开、立刻生效。
func TestWrapUpReminderSettingIsDeclared(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	spec, declared := schema.spec(wrapUpReminderKey)
	if !declared || spec.Group != sessionGroup || spec.Type != settingBoolean || spec.Scope != deviceScope || spec.Restart != restartNone || spec.Default != true {
		t.Fatalf("提醒收尾的开关没有照设备级、默认开的布尔项声明: %+v", spec)
	}
	if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
		t.Fatal("提醒收尾的开关缺中文或者英文的标题、说明")
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{edit(wrapUpReminderKey, false)}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 1 {
		t.Fatalf("写成关应该能写进去: %v %+v %v", changed, problem, err)
	}
}

// 每回合收尾的总开关：同一组、设备级的布尔项、默认开、不用重启；排在提醒收尾前面。
func TestWrapUpSettingIsDeclared(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	spec, declared := schema.spec(wrapUpKey)
	if !declared || spec.Group != sessionGroup || spec.Type != settingBoolean || spec.Scope != deviceScope || spec.Restart != restartNone || spec.Default != true {
		t.Fatalf("每回合收尾的开关没有照设备级、默认开的布尔项声明: %+v", spec)
	}
	if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
		t.Fatal("每回合收尾的开关缺中文或者英文的标题、说明")
	}
	order := map[string]int{}
	for index, one := range schema.Settings {
		order[one.Key] = index
	}
	if order[wrapUpKey] > order[wrapUpReminderKey] {
		t.Fatal("每回合收尾应排在提醒收尾前面")
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{edit(wrapUpKey, false)}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 1 {
		t.Fatalf("写成关应该能写进去: %v %+v %v", changed, problem, err)
	}
}

// 任务卡按 harness 的开关：每个 harness 自己那一组里一项，作用域 harness、默认开、不用重启；写成关能写进去，别的 harness 不受影响。
func TestTaskCardsSettingIsDeclaredPerHarness(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	for _, id := range knownHarnesses {
		spec, declared := schema.spec(taskCardsKey(id))
		if !declared || spec.Group != "harness."+id || spec.Type != settingBoolean || spec.Scope != harnessScope(id) || spec.Restart != restartNone || spec.Default != true {
			t.Fatalf("%s 的任务卡开关没有照 harness 级、默认开的布尔项声明: %+v", id, spec)
		}
		if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
			t.Fatalf("%s 的任务卡开关缺中文或者英文的标题、说明", id)
		}
	}
	if taskCardsKey("pi") != "harness.pi.taskCards" {
		t.Fatalf("键名应和 packages/protocol/src/session-tree.mts 的 taskCardsSettingKey 一样: %s", taskCardsKey("pi"))
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{edit(taskCardsKey("pi"), false)}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 1 {
		t.Fatalf("写成关应该能写进去: %v %+v %v", changed, problem, err)
	}
	if _, written := cfg.settings.lookup(taskCardsKey("claude-code")); written {
		t.Fatal("别的 harness 的任务卡开关不该被写")
	}
}
