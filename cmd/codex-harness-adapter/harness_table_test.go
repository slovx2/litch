package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// OpenCode 和 ACP 那几个入口：参数、入口路径、固定的环境变量都出自登记表。
func TestNewerHarnessOptions(t *testing.T) {
	cfg, err := parseConfiguration([]string{"--home", t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for id, port := range map[string]int{"claude-code": 7331, "pi": 7332, "dsh": 7333, "opencode": 7334, "gemini": 7335, "qwen": 7336, "acp": 7337} {
		if cfg.forHarness(id).port != port {
			t.Fatalf("%s 的默认端口应是 %d: %d", id, port, cfg.forHarness(id).port)
		}
	}
	for _, args := range [][]string{{"--opencode-port", "7331"}, {"--gemini-port", "7334"}, {"--acp-port", "0"}, {"--qwen-port", "70000"}, {"--harness", "codex"}, {"--harness", "nope"}} {
		if _, err := parseConfiguration(append([]string{"--home", t.TempDir()}, args...)); err == nil {
			t.Fatalf("应拒绝 %v", args)
		}
	}
	paths := map[string]string{"opencode": "opencode", "gemini": "acp", "qwen": "acp", "acp": "acp"}
	for id, pkg := range paths {
		cfg, err := parseConfiguration([]string{"--home", t.TempDir(), "--harness", id})
		if err != nil {
			t.Fatal(err)
		}
		if want := filepath.Join(cfg.root, "packages", pkg, "dist", pkg, "src", "adapter.mjs"); cfg.adapter() != want {
			t.Fatalf("%s 的入口应是 %s: %s", id, want, cfg.adapter())
		}
		if cfg.port != specOf(id).defaultPort {
			t.Fatalf("单独启动 %s 时用它自己的默认端口: %d", id, cfg.port)
		}
		environment := map[string]string{}
		for _, entry := range cfg.environment() {
			name, value, _ := strings.Cut(entry, "=")
			environment[name] = value
		}
		// 每个引擎的状态目录变量都是这个入口的目录；ACP 引擎另外知道自己扮演谁
		for _, variable := range []string{"CHA_OPENCODE_HOME", "CHA_GEMINI_HOME", "CHA_QWEN_HOME", "CHA_ACP_HOME", "CHA_DSH_HOME"} {
			if environment[variable] != cfg.directory() {
				t.Fatalf("%s 的 %s 不对: %q", id, variable, environment[variable])
			}
		}
		agent, given := environment[acpAgentVariable]
		if (pkg == "acp") != given || (given && agent != id) {
			t.Fatalf("%s 的 %s 不对: %q %v", id, acpAgentVariable, agent, given)
		}
	}
	// 这几个固定变量不许在设置里改
	for _, name := range []string{"CHA_OPENCODE_HOME", "CHA_ACP_HOME", acpAgentVariable} {
		if !isFixedEnvironmentName(name) {
			t.Fatalf("%s 应是固定变量", name)
		}
	}
	// 帮助里列着新的端口参数和 --harness 的取值，第一行不变（Homebrew 配方的自检按它匹配）
	help := usage()
	if !strings.HasPrefix(help, "用法: codex-harness-adapter start|init|serve|ssh-config|doctor [选项]\n") ||
		!strings.Contains(help, "--opencode-port 7334") || !strings.Contains(help, "--acp-port 7337") || !strings.Contains(help, "claude-code|pi|dsh|opencode|gemini|qwen|acp") {
		t.Fatalf("帮助文字不对: %s", help)
	}
}

// OpenCode 装了才启用：CHA_OPENCODE_CLI、PATH 里的 opencode、~/.opencode/bin/opencode 三处都算。
func TestOpencodeJoinsDefaultStartOnlyWhenInstalled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("用 POSIX 可执行位构造假 opencode")
	}
	opencodeInstalled = detectOpencode
	t.Cleanup(func() { opencodeInstalled = func(configuration) bool { return false } })
	empty, onPath, home := t.TempDir(), t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(onPath, "opencode"), []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	harnesses := func() []string {
		cfg, err := parseConfiguration([]string{"--home", t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		cfg.settings, _ = loadSettings(cfg.home)
		names := []string{}
		for _, entry := range cfg.entries() {
			names = append(names, entry.harness)
		}
		if enabled := cfg.defaultEnabled("opencode"); enabled != slices.Contains(names, "opencode") {
			t.Fatalf("默认启用和入口名单对不上: %v %v", enabled, names)
		}
		return names
	}
	t.Setenv("CHA_OPENCODE_CLI", "")
	t.Setenv("HOME", home)
	t.Setenv("PATH", empty)
	if got := harnesses(); slices.Contains(got, "opencode") {
		t.Fatalf("没装 opencode 时不应出现它的入口: %v", got)
	}
	t.Setenv("PATH", empty+string(os.PathListSeparator)+onPath)
	if got := harnesses(); !slices.Equal(got, []string{"claude-code", "pi", "opencode"}) {
		t.Fatalf("PATH 里有 opencode 时应带上它的入口: %v", got)
	}
	// 官方安装脚本的位置：不在 PATH 里也算装了
	t.Setenv("PATH", empty)
	if err := os.MkdirAll(filepath.Join(home, ".opencode", "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".opencode", "bin", "opencode"), []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := harnesses(); !slices.Contains(got, "opencode") {
		t.Fatalf("~/.opencode/bin 里有 opencode 时应带上它的入口: %v", got)
	}
	if err := os.Remove(filepath.Join(home, ".opencode", "bin", "opencode")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHA_OPENCODE_CLI", filepath.Join(empty, "missing"))
	if got := harnesses(); !slices.Contains(got, "opencode") {
		t.Fatalf("设置 CHA_OPENCODE_CLI 后应带上它的入口: %v", got)
	}
}

// ACP 那几个默认不启用；在设置里打开才起。自填命令的 acp 没给命令行时打开了也不去试，报没装。
func TestACPHarnessesAreOptIn(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	t.Setenv("CHA_ACP_CLI", "")
	if err := os.Unsetenv("CHA_ACP_CLI"); err != nil {
		t.Fatal(err)
	}
	manager := newHarnessManager(cfg)
	for _, id := range []string{"gemini", "qwen", "acp"} {
		if cfg.defaultEnabled(id) {
			t.Fatalf("%s 默认不该启用", id)
		}
		if enabled, state, _ := manager.wanted(id); enabled || state != stateDisabled {
			t.Fatalf("%s 默认应是停用: %v %s", id, enabled, state)
		}
	}
	schema := buildSettingsSchema(cfg)
	edits := []settingEdit{edit(enabledKey("gemini"), true), edit(enabledKey("acp"), true)}
	if _, problem, err := cfg.settings.apply(0, edits, schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写设置失败: %v %+v", err, problem)
	}
	if enabled, _, _ := manager.wanted("gemini"); !enabled {
		t.Fatal("打开之后 gemini 应启用")
	}
	names := []string{}
	for _, entry := range cfg.entries() {
		names = append(names, entry.harness)
	}
	if !slices.Equal(names, []string{"claude-code", "pi", "gemini", "acp"}) {
		t.Fatalf("设置里打开的应进入口名单: %v", names)
	}
	enabled, state, text := manager.wanted("acp")
	if enabled || state != stateNotInstalled || !strings.Contains(text.ZH, "CHA_ACP_CLI") || !strings.Contains(text.ZH, "CHA_ACP_ARGS") || !strings.Contains(text.EN, cliPathKey("acp")) {
		t.Fatalf("acp 没给命令行时应报没装并说怎么给: %v %s %+v", enabled, state, text)
	}
	// 绝对路径要按所在系统的写法给（Windows 上 /opt/... 不算绝对路径）
	agent := filepath.Join(t.TempDir(), "agent")
	if _, problem, err := cfg.settings.apply(1, []settingEdit{edit(cliPathKey("acp"), agent)}, schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写设置失败: %v %+v", err, problem)
	}
	if enabled, _, _ := manager.wanted("acp"); !enabled || cfg.forHarness("acp").settingsEnv["CHA_ACP_CLI"] != agent {
		t.Fatalf("给了命令行之后 acp 应启用，路径落到 CHA_ACP_CLI 上: %v", cfg.forHarness("acp").settingsEnv)
	}
	// 分组里说明怎么接、参数怎么改；ACP 的几项设置都在
	for _, id := range []string{"gemini", "qwen", "acp"} {
		var group *settingGroup
		for index := range schema.Groups {
			if schema.Groups[index].ID == "harness."+id {
				group = &schema.Groups[index]
			}
		}
		if group == nil || group.Description == nil || !strings.Contains(group.Description.ZH, "ACP") || !strings.Contains(group.Description.ZH, "_ARGS") {
			t.Fatalf("%s 的分组说明不对: %+v", id, group)
		}
		if spec, known := schema.spec(sshPortKey(id)); !known || spec.Default != specOf(id).defaultPort {
			t.Fatalf("%s 的 SSH 端口设置不对: %+v", id, spec)
		}
	}
}

// 引擎写到标准错误的原文（设计文档 06 第 1.3 节）认得出来，归到对的分类。
func TestNewerEngineFailuresAreClassified(t *testing.T) {
	for _, scenario := range []struct{ harness, fixture, kind, message string }{
		{"opencode", `console.error('宿主 OpenCode CLI 版本不符: 需要 >= 1.18.0，实际 1.2.0 INTERNAL_DETAIL'); process.exit(1);`, stateVersionTooLow, "OpenCode 版本低于"},
		{"opencode", `console.error('无法读取宿主 OpenCode CLI 版本: /opt/opencode INTERNAL_DETAIL'); process.exit(1);`, stateStartFailed, "opencode --version"},
		{"opencode", `console.error('Error: 宿主 CLI 不可执行或未找到: opencode INTERNAL_DETAIL'); process.exit(1);`, stateNotInstalled, "CHA_OPENCODE_CLI"},
		{"gemini", `console.error('ACP 协议版本不符: 需要 1，实际 0 INTERNAL_DETAIL'); process.exit(1);`, stateVersionTooLow, "Gemini CLI 说的 ACP 协议版本"},
		{"qwen", `console.error('Error: 宿主 CLI 不可执行或未找到: qwen INTERNAL_DETAIL'); process.exit(1);`, stateNotInstalled, "CHA_QWEN_CLI"},
	} {
		t.Run(scenario.harness+"-"+scenario.kind, func(t *testing.T) {
			cfg := testConfiguration(t)
			cfg.harness = scenario.harness
			writeStartFixture(t, cfg)
			if err := os.WriteFile(cfg.adapter(), []byte(scenario.fixture), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := inspectRuntime(t.Context(), cfg)
			var failure *harnessFailure
			if !errors.As(err, &failure) || failure.kind != scenario.kind || !strings.Contains(failure.text.ZH, scenario.message) {
				t.Fatalf("分类或说法不对: %v", err)
			}
		})
	}
}
