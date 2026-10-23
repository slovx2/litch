package main

import (
	"encoding/json"
	"os"
	"testing"
)

// 后台命令的开关：只有 Pi、OpenCode、通用 ACP 入口有；默认跟运行时的默认走；改了要重启；
// 写过才落到环境变量上（开是 1，关是 0），只给这个 harness，指纹只让它待重启。
func TestBackgroundShellSetting(t *testing.T) {
	t.Setenv(backgroundShellVariable, "")
	_ = os.Unsetenv(backgroundShellVariable)
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	for _, id := range knownHarnesses {
		spec, declared := schema.spec(backgroundShellKey(id))
		if declared != backgroundShellHarnesses[id] {
			t.Fatalf("%s 有没有后台命令开关不对: %v", id, declared)
		}
		if !declared {
			continue
		}
		if spec.Type != settingBoolean || spec.Default != backgroundShellDefault || spec.Restart != restartHarness ||
			spec.Group != "harness."+id || spec.Scope != harnessScope(id) || spec.Title.ZH == "" || spec.Title.EN == "" {
			t.Fatalf("%s 的开关声明不对: %+v", id, spec)
		}
	}
	variable := func(id string) string { return cfg.forHarness(id).environmentValue(backgroundShellVariable) }
	before := map[string]string{}
	for _, id := range knownHarnesses {
		if variable(id) != "" {
			t.Fatalf("没写过时不该给变量: %s", id)
		}
		before[id] = cfg.runtimeFingerprint(id, true)
	}
	write := func(version int, key string, value json.RawMessage) {
		t.Helper()
		changed, problem, err := cfg.settings.apply(version, []settingEdit{{Key: key, Value: value}}, schema, cfg.validateSettings)
		if err != nil || problem != nil || len(changed) != 1 {
			t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
		}
	}
	write(0, backgroundShellKey("opencode"), json.RawMessage(`true`))
	if variable("opencode") != "1" || variable("pi") != "" || variable("acp") != "" {
		t.Fatalf("打开 OpenCode 的之后变量不对: opencode=%q pi=%q", variable("opencode"), variable("pi"))
	}
	for _, id := range knownHarnesses {
		if changed := cfg.runtimeFingerprint(id, true) != before[id]; changed != (id == "opencode") {
			t.Fatalf("%s 的指纹变没变不对: %v", id, changed)
		}
	}
	// 环境文件里关着时，没写过的读到的默认是关；设置里写过的盖过环境文件
	if !backgroundShellDefault || !cfg.defaultBackgroundShell("pi") {
		t.Fatal("什么都没给时应默认开着")
	}
	cfg.userEnv = map[string]string{backgroundShellVariable: "0"}
	if cfg.defaultBackgroundShell("pi") {
		t.Fatal("环境文件里关着时，没写过的 Pi 读到的默认应是关着")
	}
	write(1, backgroundShellKey("pi"), json.RawMessage(`true`))
	if variable("pi") != "1" {
		t.Fatalf("打开之后变量应是 1: %q", variable("pi"))
	}
	write(2, backgroundShellKey("acp"), json.RawMessage(`false`))
	if variable("acp") != "0" {
		t.Fatalf("关掉之后变量应是 0: %q", variable("acp"))
	}
}
