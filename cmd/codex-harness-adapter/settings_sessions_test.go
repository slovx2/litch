package main

import (
	"encoding/json"
	"testing"
)

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
