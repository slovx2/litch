package main

import "testing"

func TestClientToolsDeviceAuthority(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	for _, column := range []string{"browser", "computer"} {
		for _, harness := range append([]string{""}, knownHarnesses...) {
			spec, ok := schema.spec(clientToolKey(column, harness))
			if !ok || spec.Type != settingBoolean || spec.Restart != restartNone {
				t.Fatalf("缺少工具设置: %s %s", column, harness)
			}
		}
	}
	_, values, explicit := cfg.settings.present(schema)
	if values["tools.browser"] != true || values["tools.computer"] != false || len(explicit) != 0 {
		t.Fatalf("默认值不正确: %v %v", values, explicit)
	}
	_, problem, err := cfg.settings.apply(0, []settingEdit{
		edit("tools.computer", true), edit("harness.pi.computer", false), edit("tools.browser", false), edit("tools.machine", true),
	}, schema, cfg.validateSettings)
	if problem != nil || err != nil {
		t.Fatalf("写设置: %v %v", problem, err)
	}
	_, values, _ = cfg.settings.present(schema)
	effectiveSchema := cfg.clientToolDefaults(schema)
	inherited, _ := effectiveSchema.spec("harness.claude-code.computer")
	if inherited.Default != true {
		t.Fatal("harness 的默认值展示必须跟随设备")
	}
	original, _ := schema.spec("harness.claude-code.computer")
	if original.Default != false {
		t.Fatal("不能改动缓存的结构")
	}
	if values["tools.machine"] != true || values["harness.claude-code.computer"] != true || values["harness.pi.computer"] != false || values["harness.pi.browser"] != false {
		t.Fatalf("harness 应按设备现值继承: %v", values)
	}
	_, problem, err = cfg.settings.apply(1, []settingEdit{edit("harness.pi.computer", nil)}, schema, cfg.validateSettings)
	if problem != nil || err != nil {
		t.Fatalf("清覆盖: %v %v", problem, err)
	}
	_, values, explicit = cfg.settings.present(schema)
	if values["harness.pi.computer"] != true {
		t.Fatalf("清覆盖后没有继承: %v", values)
	}
	for _, key := range explicit {
		if key == "harness.pi.computer" {
			t.Fatal("继承值不应持久化")
		}
	}
}
