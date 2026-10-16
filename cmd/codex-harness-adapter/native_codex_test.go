package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	for _, item := range []struct {
		a, b string
		sign int
	}{
		{"0.160.0", "0.157.1", 1},
		{"0.157.1", "0.157.1", 0},
		{"0.157.0", "0.157.1", -1},
		{"0.99.9", "0.157.1", -1},
		{"1.0.0", "0.999.9", 1},
		// 预发布版按版本号的先后比：更高版本的预发布版比下限新，同版本的预发布版比正式版旧。
		{"0.162.0-alpha.20", "0.157.1", 1},
		{"0.157.1-alpha.3", "0.157.1", -1},
		{"0.157.1-alpha.3", "0.157.1-alpha.10", -1},
		{"0.157.1-alpha.3", "0.157.1-alpha.3", 0},
		{"0.157.1-alpha", "0.157.1-alpha.1", -1},
		{"0.157.1-beta.1", "0.157.1-alpha.9", 1},
		// 认得出 `codex --version` 那一行里的版本号。
		{"codex-cli 0.160.0", "0.157.1", 1},
	} {
		order, ok := compareVersions(item.a, item.b)
		sign := 0
		if order > 0 {
			sign = 1
		} else if order < 0 {
			sign = -1
		}
		if !ok || sign != item.sign {
			t.Fatalf("%s 和 %s 比出来是 %d（认得出：%v），应为 %d", item.a, item.b, order, ok, item.sign)
		}
	}
	if _, ok := compareVersions("没有版本号", "0.157.1"); ok {
		t.Fatal("认不出的版本号不该比出结果")
	}
}

// 原生 codex 的三项设置照别的 harness 的结构声明，装了才默认开；没有 SSH 入口的设置；CODEX_HOME 只有它能设。
func TestCodexSettingsAreDeclared(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	for _, key := range []string{enabledKey(nativeCodex), cliPathKey(nativeCodex), envKey(nativeCodex)} {
		spec, ok := schema.spec(key)
		if !ok || spec.Scope != harnessScope(nativeCodex) || spec.Restart != restartHarness || spec.Group != "harness.codex" {
			t.Fatalf("%s 没有照 harness 的设置声明: %+v", key, spec)
		}
		if spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
			t.Fatalf("%s 缺中文或者英文的标题、说明: %+v", key, spec)
		}
	}
	if spec, _ := schema.spec(enabledKey(nativeCodex)); spec.Default != false {
		t.Fatalf("没装 codex 时原生 codex 应默认关: %+v", spec.Default)
	}
	// 装了就默认开；--harness 单选了别的时，它和别的 harness 一样不开。
	codexInstalled = func(configuration) bool { return true }
	t.Cleanup(func() { codexInstalled = func(configuration) bool { return false } })
	if spec, _ := buildSettingsSchema(cfg).spec(enabledKey(nativeCodex)); spec.Default != true {
		t.Fatalf("装了 codex 时原生 codex 应默认开: %+v", spec.Default)
	}
	single := cfg
	single.harness = "pi"
	if single.defaultEnabled(nativeCodex) || !single.defaultEnabled("pi") {
		t.Fatal("--harness 单选了别的时原生 codex 不该默认开")
	}
	codexInstalled = func(configuration) bool { return false }
	var group *settingGroup
	for index := range schema.Groups {
		if schema.Groups[index].ID == "harness.codex" {
			group = &schema.Groups[index]
		}
	}
	if group == nil || group.Title.ZH != "Codex" || group.Description == nil || !strings.Contains(group.Description.ZH, "~/.codex") || group.Description.EN == "" {
		t.Fatalf("原生 codex 那一组应说明它用的是用户自己的数据: %+v", group)
	}
	for _, key := range []string{sshEnabledKey(nativeCodex), sshPortKey(nativeCodex)} {
		if _, ok := schema.spec(key); ok {
			t.Fatalf("原生 codex 没有 SSH 入口，不该有 %s", key)
		}
	}

	home := filepath.Join(cfg.home, "another-codex-home")
	custom := []map[string]any{{"name": "CODEX_HOME", "value": home}}
	if _, problem, err := cfg.settings.apply(0, []settingEdit{edit(envKey("pi"), custom)}, schema, cfg.validateSettings); err != nil || problem == nil || problem.reason != "invalid" {
		t.Fatalf("适配器自己的引擎不许在设置里改 CODEX_HOME: %+v %v", problem, err)
	}
	// 命令行路径要求是绝对路径，而“绝对”各平台写法不同：从状态目录拼，不写死成 POSIX 的样子。
	cli := filepath.Join(cfg.home, "codex-bin", "codex")
	if _, problem, err := cfg.settings.apply(0, []settingEdit{
		edit(envKey(nativeCodex), custom), edit(cliPathKey(nativeCodex), cli),
	}, schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("原生 codex 的 CODEX_HOME 应可以在设置里给: %+v %v", problem, err)
	}
	entry := cfg.forHarness(nativeCodex)
	if !entry.native() || !entry.sshDisabled || len(entry.settingsEnv) != 1 {
		t.Fatalf("原生 codex 的配置不对（没有 SSH 入口，命令行路径不落到环境变量上）: %+v", entry.settingsEnv)
	}
	if got := entry.environmentValue("CODEX_HOME"); got != home {
		t.Fatalf("原生 codex 的 CODEX_HOME 应是设置里给的 %s，得到 %s", home, got)
	}
	// 别的引擎照旧：数据目录由适配器定死在自己的状态目录里。
	pi := cfg.forHarness("pi")
	if got := pi.environmentValue("CODEX_HOME"); got != filepath.Join(pi.directory(), "codex") {
		t.Fatalf("适配器自己的引擎的 CODEX_HOME 不该变: %s", got)
	}
}

// 原生 codex 只经聚合面提供：没有聚合面时设置里开着也不起。写过设置的以设置为准，没写过的看装没装。
func TestCodexWantedOnlyWithAggregate(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	manager := newHarnessManager(cfg)
	manager.aggregate = true
	if enabled, state, text := manager.wanted(nativeCodex); enabled || state != stateNotInstalled || !strings.Contains(text.ZH, cliPathKey(nativeCodex)) || text.EN == "" {
		t.Fatalf("没装 codex、没写过设置时原生 codex 应报没装: %v %s %s", enabled, state, text.ZH)
	}
	codexInstalled = func(configuration) bool { return true }
	t.Cleanup(func() { codexInstalled = func(configuration) bool { return false } })
	if enabled, _, _ := manager.wanted(nativeCodex); !enabled {
		t.Fatal("装了 codex、没写过设置时应该要起")
	}
	if _, problem, err := cfg.settings.apply(0, []settingEdit{edit(enabledKey(nativeCodex), false)}, manager.schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	if enabled, state, _ := manager.wanted(nativeCodex); enabled || state != stateDisabled {
		t.Fatalf("设置里关掉的，装了也不起: %v %s", enabled, state)
	}
	if _, problem, err := cfg.settings.apply(1, []settingEdit{edit(enabledKey(nativeCodex), true)}, manager.schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	if enabled, _, _ := manager.wanted(nativeCodex); !enabled {
		t.Fatal("设置里打开之后应该要起")
	}
	manager.aggregate = false
	if enabled, state, text := manager.wanted(nativeCodex); enabled || state != stateDisabled || !strings.Contains(text.ZH, "聚合面") {
		t.Fatalf("没有聚合面时不该起原生 codex: %v %s %s", enabled, state, text.ZH)
	}
	if enabled, _, _ := manager.wanted("pi"); !enabled {
		t.Fatal("别的 harness 不受聚合面有没有的影响")
	}
}
