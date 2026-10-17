package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/slovx2/litch/packages/protocol"
)

func settingsTestConfiguration(t *testing.T) configuration {
	t.Helper()
	cfg := testConfiguration(t)
	cfg.harness, cfg.port = "", 0
	cfg.ports = nil
	settings, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.settings = settings
	return cfg
}

func edit(key string, value any) settingEdit {
	data, _ := json.Marshal(value)
	return settingEdit{Key: key, Value: data}
}

// 第一批设置里没有用到的几种类型，借这三项把它们的规矩也测到。
func extendedSchema(cfg configuration) settingsSchema {
	schema := buildSettingsSchema(cfg)
	schema.Settings = append(schema.Settings,
		settingSpec{Key: "test.label", Group: "ssh", Type: settingString, Scope: deviceScope, Default: "", Restart: restartNone},
		settingSpec{Key: "test.mode", Group: "ssh", Type: settingEnum, Scope: deviceScope, Default: "a", Restart: restartNone,
			Options: []settingOption{{Value: "a", Title: verbatim("A")}, {Value: "b", Title: verbatim("B")}}},
		settingSpec{Key: "test.token", Group: "ssh", Type: settingSecret, Scope: deviceScope, Default: map[string]bool{"set": false}, Restart: restartNone},
	)
	return schema
}

// 没有设置文件时一切照启动参数来，和没有这个功能时一样。
func TestSettingsDefaultToStartupOptions(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	cfg.sshDisabled = true
	if _, err := os.Stat(settingsPath(cfg.home)); !os.IsNotExist(err) {
		t.Fatal("读设置不该把文件建出来")
	}
	pi := cfg.forHarness("pi")
	if pi.port != 7332 || !pi.sshDisabled || len(pi.settingsEnv) != 0 {
		t.Fatalf("没写过设置时应照启动参数: %+v", pi)
	}
	version, values, explicit := cfg.settings.present(buildSettingsSchema(cfg))
	if version != 0 || len(explicit) != 0 {
		t.Fatalf("没写过设置时版本号应为 0、没有写过的键: %d %v", version, explicit)
	}
	for key, want := range map[string]any{
		"harness.claude-code.enabled": true, "harness.pi.enabled": true, "harness.dsh.enabled": false,
		"harness.pi.cliPath": "", "ssh.pi.enabled": false, "ssh.claude-code.port": 7331, "ssh.dsh.port": 7333,
	} {
		if values[key] != want {
			t.Fatalf("%s 的默认值应为 %v，得到 %v", key, want, values[key])
		}
	}
	// --harness 选了一个时，别的默认不启用，但仍然列在结构里，可以在设置里启用。
	cfg.harness, cfg.port = "pi", 7443
	_, values, _ = cfg.settings.present(buildSettingsSchema(cfg))
	if values["harness.claude-code.enabled"] != false || values["harness.pi.enabled"] != true || values["ssh.pi.port"] != 7443 {
		t.Fatalf("--harness 应只让选中的默认启用: %v", values)
	}
}

func TestSettingsWriteOverridesStartupOptions(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	t.Setenv("HTTPS_PROXY", "http://from-process")
	cfg.userEnv = map[string]string{"HTTPS_PROXY": "http://from-file", "ONLY_IN_FILE": "kept"}
	cliPath := filepath.Join(cfg.home, "pi-cli.js")
	changed, problem, err := cfg.settings.apply(0, []settingEdit{
		edit("ssh.pi.port", 7555),
		edit("ssh.claude-code.enabled", false),
		edit("harness.pi.cliPath", cliPath),
		edit("harness.pi.env", []map[string]any{{"name": "HTTPS_PROXY", "value": "http://from-settings"}}),
	}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 4 {
		t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
	}
	if info, err := os.Stat(settingsPath(cfg.home)); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("设置文件应只有属主可读写: %v %v", info, err)
	}
	// 重新从磁盘读，和服务重启后看到的一样。
	reloaded, err := loadSettings(cfg.home)
	if err != nil || reloaded.version != 1 {
		t.Fatalf("重读设置失败: %+v %v", reloaded, err)
	}
	cfg.settings = reloaded
	pi, claude := cfg.forHarness("pi"), cfg.forHarness("claude-code")
	if pi.port != 7555 || pi.sshDisabled || !claude.sshDisabled || claude.port != 7331 {
		t.Fatalf("设置没有盖过启动参数: pi=%+v claude=%+v", pi, claude)
	}
	environment := map[string]string{}
	for _, entry := range pi.environment() {
		name, value, _ := strings.Cut(entry, "=")
		if _, twice := environment[name]; twice && name == "HTTPS_PROXY" {
			t.Fatal("同一个变量给了两次")
		}
		environment[name] = value
	}
	// 设置 > 进程环境 > 环境文件；固定变量谁也盖不过。
	if environment["HTTPS_PROXY"] != "http://from-settings" || environment["ONLY_IN_FILE"] != "kept" ||
		environment["PI_CLI"] != cliPath || environment["CHA_PI_HOME"] != pi.directory() {
		t.Fatalf("环境变量的优先级不对: %v", environment)
	}
	// 别的 harness 不受影响。
	for _, entry := range claude.environment() {
		if strings.HasPrefix(entry, "PI_CLI=") || entry == "HTTPS_PROXY=http://from-settings" {
			t.Fatalf("Pi 的设置漏到了 Claude Code 上: %s", entry)
		}
	}
	// 清掉一项就回到默认值。
	if _, problem, err := cfg.settings.apply(1, []settingEdit{{Key: "ssh.pi.port", Value: json.RawMessage("null")}}, schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("清除失败: %+v %v", problem, err)
	}
	if cfg.forHarness("pi").port != 7332 {
		t.Fatal("清掉之后没有回到启动参数给的端口")
	}
}

func TestSettingsRejectStaleVersionAndBadValues(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := extendedSchema(cfg)
	apply := func(expected int, edits ...settingEdit) *settingsProblem {
		t.Helper()
		_, problem, err := cfg.settings.apply(expected, edits, schema, cfg.validateSettings)
		if err != nil {
			t.Fatal(err)
		}
		return problem
	}
	if problem := apply(0, edit("test.label", "first")); problem != nil {
		t.Fatalf("写入失败: %+v", problem)
	}
	// 版本号对不上：整个拒绝，什么都没写。
	if problem := apply(0, edit("test.label", "second")); problem == nil || problem.reason != "conflict" {
		t.Fatalf("旧版本号的写入应被拒绝: %+v", problem)
	}
	if cfg.settings.text("test.label") != "first" || cfg.settings.version != 1 {
		t.Fatal("被拒绝的写入改了设置")
	}
	for name, bad := range map[string]settingEdit{
		"不认识的键":    edit("no.such.key", true),
		"开关给了数字":   edit("harness.pi.enabled", 1),
		"端口给了小数":   edit("ssh.pi.port", 73.5),
		"端口超出范围":   edit("ssh.pi.port", 70000),
		"端口和别的入口撞": edit("ssh.pi.port", 7331),
		"路径不是绝对的":  edit("harness.pi.cliPath", "bin/pi"),
		"单选不在选项里":  edit("test.mode", "c"),
		"文字里有换行":   edit("test.label", "a\nb"),
		"变量名不合规矩":  edit("harness.pi.env", []map[string]any{{"name": "1BAD", "value": "x"}}),
		"变量重复":     edit("harness.pi.env", []map[string]any{{"name": "A", "value": "1"}, {"name": "A", "value": "2"}}),
		"固定变量":     edit("harness.pi.env", []map[string]any{{"name": "CODEX_HOME", "value": "/elsewhere"}}),
		"普通变量没给值":  edit("harness.pi.env", []map[string]any{{"name": "PLAIN"}}),
		"没有原值的密钥":  edit("harness.pi.env", []map[string]any{{"name": "API_KEY", "secret": true}}),
	} {
		if problem := apply(1, bad); problem == nil || problem.reason != "invalid" || problem.key != bad.Key || problem.text.ZH == "" || problem.text.EN == "" {
			t.Fatalf("%s 应被拒绝并指出是哪一项: %+v", name, problem)
		}
	}
	// 一次写入里有一项不对，别的也不写。
	if problem := apply(1, edit("test.mode", "b"), edit("ssh.pi.port", 0)); problem == nil {
		t.Fatal("有一项不对的写入应整个被拒绝")
	}
	if _, written := cfg.settings.lookup("test.mode"); written || cfg.settings.version != 1 {
		t.Fatal("被拒绝的写入留下了一部分")
	}
	// 没有变化的写入不涨版本号。
	if changed, problem, _ := cfg.settings.apply(1, []settingEdit{edit("test.label", "first")}, schema, nil); problem != nil || len(changed) != 0 || cfg.settings.version != 1 {
		t.Fatalf("没有变化的写入不该涨版本号: %v %+v", changed, problem)
	}
}

// 密钥只能写、不能读回：读到的只有“设没设过”，环境变量表里的密钥不带值。
func TestSecretsAreWriteOnly(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := extendedSchema(cfg)
	apply := func(edits ...settingEdit) {
		t.Helper()
		if _, problem, err := cfg.settings.apply(cfg.settings.version, edits, schema, cfg.validateSettings); err != nil || problem != nil {
			t.Fatalf("写入失败: %+v %v", problem, err)
		}
	}
	apply(edit("test.token", "TOP-SECRET-1"), edit("harness.pi.env", []map[string]any{
		{"name": "HTTPS_PROXY", "value": "http://proxy"},
		{"name": "ANTHROPIC_API_KEY", "value": "TOP-SECRET-2"},
		{"name": "CUSTOM", "value": "TOP-SECRET-3", "secret": true},
	}))
	present := func() string {
		_, values, _ := cfg.settings.present(schema)
		data, err := json.Marshal(values)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	seen := present()
	if strings.Contains(seen, "TOP-SECRET") {
		t.Fatalf("读设置时带出了密钥: %s", seen)
	}
	for _, want := range []string{`"test.token":{"set":true}`, `{"name":"HTTPS_PROXY","value":"http://proxy"}`,
		`{"name":"ANTHROPIC_API_KEY","secret":true}`, `{"name":"CUSTOM","secret":true}`} {
		if !strings.Contains(seen, want) {
			t.Fatalf("读到的设置里缺少 %s: %s", want, seen)
		}
	}
	// 界面改别的变量时把密钥原样带回来（不带值）：接着用原来的值。换新值、删掉也都行。
	apply(edit("harness.pi.env", []map[string]any{
		{"name": "ANTHROPIC_API_KEY", "secret": true},
		{"name": "CUSTOM", "value": "TOP-SECRET-4", "secret": true},
		{"name": "ADDED", "value": "plain"},
	}))
	environment := cfg.forHarness("pi").settingsEnv
	if environment["ANTHROPIC_API_KEY"] != "TOP-SECRET-2" || environment["CUSTOM"] != "TOP-SECRET-4" || environment["ADDED"] != "plain" {
		t.Fatalf("密钥没有按规矩保留或更新: %v", environment)
	}
	if _, kept := environment["HTTPS_PROXY"]; kept {
		t.Fatal("表里去掉的变量还在")
	}
	// 密钥改成普通变量时必须重新给值，不然就等于把它读出来了。
	if _, problem, _ := cfg.settings.apply(cfg.settings.version, []settingEdit{edit("harness.pi.env", []map[string]any{{"name": "CUSTOM"}})}, schema, nil); problem == nil {
		t.Fatal("不带值地把密钥改成普通变量应被拒绝")
	}
	apply(settingEdit{Key: "test.token", Value: json.RawMessage(`""`)})
	if !strings.Contains(present(), `"test.token":{"set":false}`) {
		t.Fatal("写空串应清掉密钥")
	}
	// 环境文件里的变量一并给出，看着像密钥的不带值。
	inherited, _ := json.Marshal(inheritedEnvironment(map[string]string{"NO_PROXY": "localhost", "OPENAI_API_KEY": "TOP-SECRET-5"}))
	if string(inherited) != `[{"name":"NO_PROXY","value":"localhost","secret":false},{"name":"OPENAI_API_KEY","secret":true}]` {
		t.Fatalf("环境文件里的变量给得不对: %s", inherited)
	}
}

func TestBrokenSettingsFileIsRejected(t *testing.T) {
	cfg := testConfiguration(t)
	if err := os.MkdirAll(filepath.Dir(settingsPath(cfg.home)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath(cfg.home), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := run(t.Context(), []string{"ssh-config", "--home", cfg.home})
	if err == nil || !strings.Contains(err.Error(), "settings.json") {
		t.Fatalf("坏掉的设置文件应报错并指出文件: %v", err)
	}
	// 给客户端的两条命令用不着设置，不该被它拦住。
	if err := run(t.Context(), []string{"device-proxy", "--home", cfg.home}); err == nil || strings.Contains(err.Error(), "settings.json") {
		t.Fatalf("device-proxy 不该读设置: %v", err)
	}
}

// 别的子命令也以设置为准：ssh-config 打印的端口要和运行中的入口一致。
func TestSSHConfigFollowsSettings(t *testing.T) {
	cfg := testConfiguration(t)
	cfg.harness = "pi"
	if err := initialize(cfg); err != nil {
		t.Fatal(err)
	}
	settings, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.settings = settings
	base := cfg
	base.harness, base.port, base.ports = "", 0, nil
	if _, problem, err := settings.apply(0, []settingEdit{edit("ssh.pi.port", 7555)}, buildSettingsSchema(base), base.validateSettings); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	output, err := captureTerminal(t, func() error { return run(t.Context(), []string{"ssh-config", "--home", cfg.home, "--harness", "pi"}) })
	if err != nil || !strings.Contains(output, "Port 7555") || !strings.Contains(output, "Host codex-harness-adapter-pi") {
		t.Fatalf("ssh-config 没有用设置里的端口: %s %v", output, err)
	}
}

// 每个 harness 那一组的标题用的是登记的显示名（packages/protocol/src/harness-identity.json），
// 引擎在 runtime/info 里自报的也是那一份。dsh 用产品自己的叫法，不用命令名。
func TestHarnessGroupTitlesComeFromTheSharedIdentity(t *testing.T) {
	identities := protocol.HarnessIdentities()
	schema := buildSettingsSchema(settingsTestConfiguration(t))
	for _, id := range knownHarnesses {
		identity := identities[id]
		if identity.DisplayName == "" || len(identity.Badge) != 2 {
			t.Fatalf("%s 没有登记名字或者徽标: %+v", id, identity)
		}
		titled := false
		for _, group := range schema.Groups {
			if group.ID == "harness."+id {
				titled = group.Title == verbatim(identity.DisplayName)
			}
		}
		if !titled || harnessNames[id] != identity.DisplayName {
			t.Fatalf("%s 那一组的标题应是登记的显示名 %q", id, identity.DisplayName)
		}
	}
	if harnessNames["dsh"] != "DSH" {
		t.Fatalf("dsh 的显示名不对: %q", harnessNames["dsh"])
	}
}

// 每个 harness 的启用项带着显式的标记，别的项都没有：界面按标记把它放到标题行上，不靠它排在第几。
func TestEnableSwitchIsMarkedExplicitly(t *testing.T) {
	schema := buildSettingsSchema(settingsTestConfiguration(t))
	marked := map[string]string{}
	for _, spec := range schema.Settings {
		if spec.Role == "" {
			continue
		}
		if spec.Role != roleEnable || spec.Type != settingBoolean || spec.Scope.Kind != "harness" {
			t.Fatalf("%s 的标记不对: %+v", spec.Key, spec)
		}
		if previous, twice := marked[spec.Scope.Harness]; twice {
			t.Fatalf("%s 有两项启用开关: %s、%s", spec.Scope.Harness, previous, spec.Key)
		}
		marked[spec.Scope.Harness] = spec.Key
	}
	for _, id := range knownHarnesses {
		if marked[id] != enabledKey(id) {
			t.Fatalf("%s 的启用项没有带标记: %v", id, marked)
		}
	}
	// 线上：带标记的有 role，别的项没有这个字段。
	data, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}
	if count := strings.Count(string(data), `"role":"enable"`); count != len(knownHarnesses) || strings.Count(string(data), `"role"`) != count {
		t.Fatalf("线上的 role 字段不对: %d", count)
	}
}

// Pi 的审批开关：只有 Pi 有，默认关，改了要重启；写过才落到环境变量上（开是 1，关是 0），
// 没写过时由更低几层说了算，读设置看到的默认值和运行时实际拿到的一致。
func TestPiApprovalsSetting(t *testing.T) {
	// 跑用例的环境里不能带着这个变量（带着的话它排在环境文件前面）：先登记好结束时恢复，再拿掉。
	t.Setenv(piApprovalsVariable, "")
	_ = os.Unsetenv(piApprovalsVariable)
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	spec, declared := schema.spec(piApprovalsKey)
	if !declared || spec.Type != settingBoolean || spec.Default != false || spec.Restart != restartHarness ||
		spec.Group != "harness.pi" || spec.Scope != harnessScope("pi") || spec.Role != "" || spec.Title.ZH == "" || spec.Title.EN == "" {
		t.Fatalf("审批开关的声明不对: %+v", spec)
	}
	// 两条限制写在说明里，两种语言都有。
	for text, limits := range map[string][]string{
		spec.Description.ZH: {"子代理", "不是安全边界"},
		spec.Description.EN: {"subagents", "not a security boundary"},
	} {
		for _, limit := range limits {
			if !strings.Contains(text, limit) {
				t.Fatalf("说明里没有写清限制 %q: %s", limit, text)
			}
		}
	}
	for _, other := range schema.Settings {
		if strings.HasSuffix(other.Key, ".approvals") && other.Key != piApprovalsKey {
			t.Fatalf("只有 Pi 有审批开关: %s", other.Key)
		}
	}
	variable := func(id string) string { return cfg.forHarness(id).environmentValue(piApprovalsVariable) }
	shown := func() any {
		_, values, _ := cfg.settings.present(buildSettingsSchema(cfg))
		return values[piApprovalsKey]
	}
	write := func(version int, value json.RawMessage) {
		t.Helper()
		changed, problem, err := cfg.settings.apply(version, []settingEdit{{Key: piApprovalsKey, Value: value}}, schema, cfg.validateSettings)
		if err != nil || problem != nil || len(changed) != 1 {
			t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
		}
	}

	// 没写过：不给变量，和加这一项之前起运行时的环境一样。
	if variable("pi") != "" || len(cfg.forHarness("pi").settingsEnv) != 0 || shown() != false {
		t.Fatalf("没写过时不该给变量: %q %v", variable("pi"), shown())
	}
	untouched, claude := cfg.runtimeFingerprint("pi", true), cfg.runtimeFingerprint("claude-code", true)

	// 打开：变量是 1，只给 Pi；指纹变了（运行着的要重启才生效），别的 harness 的不变。
	write(0, json.RawMessage("true"))
	on := cfg.runtimeFingerprint("pi", true)
	if variable("pi") != "1" || variable("claude-code") != "" || variable("dsh") != "" || shown() != true {
		t.Fatalf("打开之后变量不对: pi=%q claude=%q", variable("pi"), variable("claude-code"))
	}
	if on == untouched || cfg.runtimeFingerprint("claude-code", true) != claude {
		t.Fatal("打开审批应只让 Pi 的运行时待重启")
	}

	// 关掉是明说的 0：盖过设置里那张环境变量表、启动服务的环境、环境文件里的同名变量。
	cfg.userEnv = map[string]string{piApprovalsVariable: "1"}
	write(1, json.RawMessage("false"))
	if variable("pi") != "0" || shown() != false || cfg.runtimeFingerprint("pi", true) == on {
		t.Fatalf("关掉之后变量应是 0: %q", variable("pi"))
	}

	// 清掉这一项：回到更低几层说了算。环境文件里开着的，设置里读到的也是开着。
	write(2, json.RawMessage("null"))
	if variable("pi") != "1" || shown() != true || cfg.runtimeFingerprint("pi", true) != untouched {
		t.Fatalf("清掉之后应由环境文件说了算: %q %v", variable("pi"), shown())
	}
	if _, _, explicit := cfg.settings.present(buildSettingsSchema(cfg)); len(explicit) != 0 {
		t.Fatalf("清掉之后不该还算写过: %v", explicit)
	}
	cfg.userEnv = nil
	if variable("pi") != "" || shown() != false {
		t.Fatal("环境文件里没有时默认是关")
	}
	// 启动服务的环境里开着的也一样；设置里那张环境变量表排在它前面。
	t.Setenv(piApprovalsVariable, "1")
	if variable("pi") != "1" || shown() != true {
		t.Fatal("启动服务的环境里开着时，设置里读到的应是开着")
	}
	if _, problem, err := cfg.settings.apply(3, []settingEdit{edit(envKey("pi"), []map[string]any{{"name": piApprovalsVariable, "value": "0"}})}, schema, cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	if variable("pi") != "0" || shown() != false {
		t.Fatal("环境变量表里的同名变量应排在启动服务的环境前面")
	}

	// 只认布尔值。
	if _, problem, err := cfg.settings.apply(4, []settingEdit{edit(piApprovalsKey, "yes")}, schema, cfg.validateSettings); err != nil || problem == nil || problem.reason != "invalid" || problem.key != piApprovalsKey {
		t.Fatalf("不是布尔值应被拒绝: %+v %v", problem, err)
	}
}
