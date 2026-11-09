package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestClaudeToolLoadingSettings(t *testing.T) {
	t.Setenv(claudeToolLoadingVariable, "")
	t.Setenv(claudeToolOverridesVariable, "")
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	for key, expected := range map[string]string{claudeToolLoadingKey: "auto", claudeToolOverridesKey: ""} {
		spec, ok := schema.spec(key)
		if !ok || spec.Default != expected || spec.Restart != restartHarness || spec.Scope != harnessScope(claudeHarness) {
			t.Fatalf("声明不对: %+v", spec)
		}
	}
	before := cfg.runtimeFingerprint(claudeHarness, true)
	pi := cfg.runtimeFingerprint("pi", true)
	_, problem, err := cfg.settings.apply(0, []settingEdit{
		{Key: claudeToolLoadingKey, Value: json.RawMessage(`"on"`)},
		{Key: claudeToolOverridesKey, Value: json.RawMessage(`"litch_browser=always, goal-tools.get_goal=defer"`)},
	}, schema, cfg.validateSettings)
	if err != nil || problem != nil {
		t.Fatalf("写入失败: %v %+v", err, problem)
	}
	env := cfg.harnessEnvironment(claudeHarness)
	if env[claudeToolLoadingVariable] != "on" || env[claudeToolOverridesVariable] != "litch_browser=always, goal-tools.get_goal=defer" {
		t.Fatalf("环境不对: %+v", env)
	}
	if cfg.harnessEnvironment("pi")[claudeToolLoadingVariable] != "" || pi != cfg.runtimeFingerprint("pi", true) || before == cfg.runtimeFingerprint(claudeHarness, true) {
		t.Fatal("只标 Claude 待重启")
	}
	for _, edit := range []settingEdit{
		{Key: claudeToolLoadingKey, Value: json.RawMessage(`"invalid"`)},
		{Key: claudeToolOverridesKey, Value: json.RawMessage(`"litch_browser=false"`)},
	} {
		if _, problem, _ := cfg.settings.apply(1, []settingEdit{edit}, schema, cfg.validateSettings); problem == nil {
			t.Fatal("非法值未拒绝")
		}
	}
	_, problem, err = cfg.settings.apply(1, []settingEdit{{Key: claudeToolLoadingKey, Value: json.RawMessage(`null`)}, {Key: claudeToolOverridesKey, Value: json.RawMessage(`null`)}}, schema, cfg.validateSettings)
	if err != nil || problem != nil {
		t.Fatalf("清除失败: %v %+v", err, problem)
	}
	_ = os.Unsetenv(claudeToolLoadingVariable)
	_ = os.Unsetenv(claudeToolOverridesVariable)
	cfg.userEnv = map[string]string{claudeToolLoadingVariable: "off", claudeToolOverridesVariable: "litch_tasks=always"}
	schema = buildSettingsSchema(cfg)
	spec, _ := schema.spec(claudeToolLoadingKey)
	if spec.Default != "off" || cfg.forHarness(claudeHarness).environmentValue(claudeToolLoadingVariable) != "off" {
		t.Fatal("未设置时应继承环境变量")
	}
}
