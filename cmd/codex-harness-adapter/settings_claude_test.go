package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Claude Code 的提示缓存时长：只有 Claude Code 有，默认跟官方一致，改了要重启；写过才落到 CHA_CLAUDE_PROMPT_CACHE_TTL 上，
// 没写过时由更低几层说了算；只认 default 和 1h。
func TestClaudeCacheTTLSetting(t *testing.T) {
	t.Setenv(claudeCacheTTLVariable, "")
	_ = os.Unsetenv(claudeCacheTTLVariable)
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	spec, declared := schema.spec(claudeCacheTTLKey)
	if !declared || spec.Type != settingEnum || spec.Default != claudeCacheTTLDefault || spec.Restart != restartHarness ||
		spec.Group != "harness.claude-code" || spec.Scope != harnessScope(claudeHarness) || len(spec.Options) != 2 ||
		spec.Options[0].Value != claudeCacheTTLDefault || spec.Options[1].Value != claudeCacheTTLHour {
		t.Fatalf("提示缓存时长的声明不对: %+v", spec)
	}
	// 说明面向普通用户：讲清更省在哪、贵在哪，两种语言都有。
	for text, points := range map[string][]string{
		spec.Description.ZH: {"长对话", "单价更高", "重启"},
		spec.Description.EN: {"long conversations", "costs more", "restarts"},
	} {
		for _, point := range points {
			if !strings.Contains(text, point) {
				t.Fatalf("说明里没写 %q: %s", point, text)
			}
		}
	}
	variable := func(id string) string { return cfg.forHarness(id).environmentValue(claudeCacheTTLVariable) }
	shown := func() any {
		_, values, _ := cfg.settings.present(buildSettingsSchema(cfg))
		return values[claudeCacheTTLKey]
	}
	write := func(version int, value json.RawMessage) {
		t.Helper()
		changed, problem, err := cfg.settings.apply(version, []settingEdit{{Key: claudeCacheTTLKey, Value: value}}, schema, cfg.validateSettings)
		if err != nil || problem != nil || len(changed) != 1 {
			t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
		}
	}

	// 没写过：不给变量，和加这一项之前一样（跟官方一致）。
	if variable(claudeHarness) != "" || len(cfg.forHarness(claudeHarness).settingsEnv) != 0 || shown() != claudeCacheTTLDefault {
		t.Fatalf("没写过时不该给变量: %q %v", variable(claudeHarness), shown())
	}
	untouched, pi := cfg.runtimeFingerprint(claudeHarness, true), cfg.runtimeFingerprint("pi", true)

	// 改成 1 小时：变量是 1h，只给 Claude Code；它的运行时待重启，别的不变。
	write(0, json.RawMessage(`"1h"`))
	hour := cfg.runtimeFingerprint(claudeHarness, true)
	if variable(claudeHarness) != "1h" || variable("pi") != "" || shown() != claudeCacheTTLHour {
		t.Fatalf("改成 1 小时之后变量不对: %q", variable(claudeHarness))
	}
	if hour == untouched || cfg.runtimeFingerprint("pi", true) != pi {
		t.Fatal("改缓存时长应只让 Claude Code 的运行时待重启")
	}

	// 明说跟官方一致：给 default，盖过更低几层里的 1h。
	cfg.userEnv = map[string]string{claudeCacheTTLVariable: "1h"}
	write(1, json.RawMessage(`"default"`))
	if variable(claudeHarness) != claudeCacheTTLDefault || shown() != claudeCacheTTLDefault {
		t.Fatalf("明说默认时应盖过环境文件: %q", variable(claudeHarness))
	}

	// 清掉：回到更低几层说了算，环境文件里是 1h，读到的也是 1h。
	write(2, json.RawMessage("null"))
	if variable(claudeHarness) != "1h" || shown() != claudeCacheTTLHour || cfg.runtimeFingerprint(claudeHarness, true) != untouched {
		t.Fatalf("清掉之后应由环境文件说了算: %q %v", variable(claudeHarness), shown())
	}
	cfg.userEnv = nil

	// 只认两个值。
	if _, problem, err := cfg.settings.apply(3, []settingEdit{edit(claudeCacheTTLKey, "5m")}, schema, cfg.validateSettings); err != nil || problem == nil || problem.reason != "invalid" || problem.key != claudeCacheTTLKey {
		t.Fatalf("不在可选值里的应被拒绝: %+v %v", problem, err)
	}
}
