package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/slovx2/litch/packages/protocol"
)

// 设置的结构由这里声明，界面按声明画，不认识具体的设置项。
// 加一项设置：在 buildSettingsSchema 里加一条声明，再在用到它的地方按键读出来。

const (
	settingBoolean = "boolean"
	settingString  = "string"
	settingInteger = "integer"
	settingEnum    = "enum"
	settingPath    = "path"
	settingEnv     = "env"
	settingSecret  = "secret"

	// 改了之后怎么生效：立刻，或者要重启它所属的那个 harness。
	restartNone    = "none"
	restartHarness = "harness"

	// 一项设置担当的角色。enable：它是所属 harness 的启用开关，界面把它另外放在那个 harness 的标题行上。
	// 界面认的是这个标记，不认键名，也不看它排在第几。
	roleEnable = "enable"
)

type settingScope struct {
	Kind    string `json:"kind"` // device、harness
	Harness string `json:"harness,omitempty"`
}

var deviceScope = settingScope{Kind: "device"}

func harnessScope(id string) settingScope { return settingScope{Kind: "harness", Harness: id} }

type settingOption struct {
	Value string    `json:"value"`
	Title bilingual `json:"title"`
}

type settingSpec struct {
	Key         string          `json:"key"`
	Group       string          `json:"group"`
	Type        string          `json:"type"`
	Title       bilingual       `json:"title"`
	Description bilingual       `json:"description"`
	Scope       settingScope    `json:"scope"`
	Default     any             `json:"default"`
	Restart     string          `json:"restart"`
	Role        string          `json:"role,omitempty"`
	Minimum     *int            `json:"minimum,omitempty"`
	Maximum     *int            `json:"maximum,omitempty"`
	Options     []settingOption `json:"options,omitempty"`
}

type settingGroup struct {
	ID          string       `json:"id"`
	Title       bilingual    `json:"title"`
	Description *bilingual   `json:"description"`
	Scope       settingScope `json:"scope"`
}

type settingsSchema struct {
	Groups   []settingGroup `json:"groups"`
	Settings []settingSpec  `json:"settings"`
}

func (s settingsSchema) spec(key string) (settingSpec, bool) {
	for _, spec := range s.Settings {
		if spec.Key == key {
			return spec, true
		}
	}
	return settingSpec{}, false
}

// 各 harness 给人看的名字：设置里每一组的标题、各处提示里提到它时用的都是这一个。
// 不在这里写：和引擎在 runtime/info 里自报的 displayName 出自同一个文件（packages/protocol/src/harness-identity.json）。
var harnessNames = func() map[string]string {
	identities := protocol.HarnessIdentities()
	names := map[string]string{}
	for _, id := range knownHarnesses {
		identity, registered := identities[id]
		if !registered || identity.DisplayName == "" {
			panic("packages/protocol/src/harness-identity.json 里没有 " + id + " 的名字")
		}
		names[id] = identity.DisplayName
	}
	return names
}()

// Pi 的审批开关落到这个环境变量上，值是 1 就打开；运行时起来时读一次（packages/pi/src/approvals.mts）。
const piApprovalsVariable = "CHA_PI_APPROVALS"

// 只有 Pi 有这一项：Claude Code 和原生 codex 问不问由会话的权限模式定，dsh 现在不问。
const piApprovalsKey = "harness.pi.approvals"

func enabledKey(id string) string    { return "harness." + id + ".enabled" }
func cliPathKey(id string) string    { return "harness." + id + ".cliPath" }
func envKey(id string) string        { return "harness." + id + ".env" }
func sshEnabledKey(id string) string { return "ssh." + id + ".enabled" }
func sshPortKey(id string) string    { return "ssh." + id + ".port" }

// 启动参数给的端口：设置里没写过时用它。
func (c configuration) defaultPort(id string) int {
	if c.harness == id && c.port != 0 {
		return c.port
	}
	return c.portOf(id)
}

// 设置里没写过“是否启用”时：--harness 选了谁就只有谁；没选时照登记表（harness_table.go）：Claude Code 和 Pi 都启用，
// 实验性的 dsh、OpenCode 和原生 codex 只在检测到本机装了它时启用（原生 codex 用的是用户自己的数据目录，见 native_codex.go），
// 经 ACP 接的几个默认不启用。
func (c configuration) defaultEnabled(id string) bool {
	if c.harness != "" {
		return c.harness == id
	}
	switch specOf(id).enable {
	case enableAlways:
		return true
	case enableWhenInstalled:
		return c.forHarness(id).installed(id)
	}
	return false
}

// 某个 harness 的现行配置：启动参数给默认值，设置里写过的盖过它。
func (c configuration) forHarness(id string) configuration {
	entry := c
	entry.port = c.settings.integer(sshPortKey(id), c.defaultPort(id))
	entry.harness = id
	entry.sshDisabled = !hasSSHEntry(id) || !c.settings.boolean(sshEnabledKey(id), !c.sshDisabled)
	entry.settingsEnv = c.harnessEnvironment(id)
	return entry
}

// 设置里只给这个 harness 的环境变量，加上落到环境变量上的那几项设置。
func (c configuration) harnessEnvironment(id string) map[string]string {
	values := c.environmentTable(id)
	// 审批开关写过才给变量：开是 1，关是 0，盖过更低几层里的同名变量。没写过就不给，由那几层说了算。
	var approvals bool
	if raw, written := c.settings.lookup(piApprovalsKey); id == "pi" && written && json.Unmarshal(raw, &approvals) == nil {
		values[piApprovalsVariable] = map[bool]string{true: "1", false: "0"}[approvals]
	}
	return values
}

// 设置里那张环境变量表，加上命令行路径那一项。
func (c configuration) environmentTable(id string) map[string]string {
	values := map[string]string{}
	for _, entry := range c.settings.env(envKey(id)) {
		if entry.Value != nil {
			values[entry.Name] = *entry.Value
		}
	}
	if variable, viaEnvironment := harnessCLIVariable[id]; viaEnvironment {
		if path := c.settings.text(cliPathKey(id)); path != "" {
			values[variable] = path
		}
	}
	return values
}

// 设置里没写过审批开关时它算开还是关：看 Pi 的运行时照更低几层（设置里的环境变量表、启动服务的环境、
// 环境文件）起来会拿到什么。那几层里把变量设成 1 的，设置里读到的就是开着，和运行时实际的一致。
// 这是给没有设置界面的安装（只经 SSH 入口用的）留的打开办法。
func (c configuration) defaultPiApprovals() bool {
	entry := c
	entry.harness, entry.settingsEnv = "pi", c.environmentTable("pi")
	return entry.environmentValue(piApprovalsVariable) == "1"
}

// 决定一个运行时怎么起的那几项设置的指纹。运行中的进程用的指纹和现在算出来的不一样，就是“待重启”。
func (c configuration) runtimeFingerprint(id string, enabled bool) string {
	settings := []any{enabled, c.settings.text(cliPathKey(id)), c.settings.env(envKey(id))}
	if id == "pi" {
		approvals, _ := c.settings.lookup(piApprovalsKey)
		settings = append(settings, string(approvals))
	}
	payload, _ := json.Marshal(settings)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:8])
}

// 写入之后的整份值要守的规矩：这次写了端口的入口，不能和别的入口撞。
func (c configuration) validateSettings(lookup func(string) (json.RawMessage, bool)) *settingsProblem {
	port := func(id string) int {
		var value int
		if raw, written := lookup(sshPortKey(id)); written && json.Unmarshal(raw, &value) == nil {
			return value
		}
		return c.defaultPort(id)
	}
	for _, id := range adapterHarnesses {
		if _, written := lookup(sshPortKey(id)); !written {
			continue
		}
		for _, other := range adapterHarnesses {
			if other != id && port(other) == port(id) {
				return invalidSetting(sshPortKey(id), both(
					"这个端口已经给了 %s 的入口，各入口的端口不能相同",
					"This port is already used by the %s entry; each entry needs its own port",
				).with(harnessNames[other]))
			}
		}
	}
	return nil
}

// 一个 harness 那三项设置（和它那一组）的说明文字。原生 codex 的另写（native_codex.go）。
type harnessTexts struct {
	group                 *bilingual
	enabled, cliPath, env bilingual
}

func harnessSettingTexts(id string) harnessTexts {
	if id == nativeCodex {
		return codexSettingTexts()
	}
	name := harnessNames[id]
	if specOf(id).acp {
		return acpSettingTexts(id)
	}
	return harnessTexts{
		enabled: both(
			"关掉后停掉 %s 的运行时，这台设备上不再提供它；会话都还在，再打开就回来。",
			"Turning this off stops the %s runtime, so this device no longer offers it. Sessions are kept and come back when you turn it on again.",
		).with(name),
		cliPath: both(
			"这台设备上 %s 命令行的绝对路径。留空就在 PATH 里找。",
			"Absolute path of the %s command-line tool on this device. Leave empty to look it up on PATH.",
		).with(name),
		env: both(
			"只给 %s 的运行时：代理、接口地址、密钥等。优先于启动服务的进程自己的环境，也优先于环境文件（状态目录下的 env）。",
			"Only for the %s runtime: proxy, API endpoint, keys and so on. These take precedence over the environment of the process that started the service and over the environment file (env in the state directory).",
		).with(name),
	}
}

// 经通用 ACP 引擎接的几个：分组里说明它怎么接、默认不启用；命令行路径一项说明预设和参数怎么改。
func acpSettingTexts(id string) harnessTexts {
	spec, name := specOf(id), harnessNames[id]
	args := strings.TrimSuffix(spec.cliVariable, "_CLI") + "_ARGS"
	group := both(
		"经 ACP（Agent Client Protocol）接入，默认不启用。参数可以在下面的环境变量里用 %s 改（按空白切分，支持双引号）。",
		"Connected over ACP (Agent Client Protocol); off by default. Change the arguments with %s in the environment variables below (split on whitespace, double quotes supported).",
	).with(args)
	cliPath := both(
		"这台设备上 %s 命令行的绝对路径，适配器以 ACP 方式起它。留空就用预设的命令，在 PATH 里找。",
		"Absolute path of the %s command-line tool on this device; the adapter starts it in ACP mode. Leave empty to use the preset command, looked up on PATH.",
	).with(name)
	if spec.needsCLI {
		cliPath = both(
			"要接的 ACP agent 的命令行（绝对路径）。没有预设，不填就起不来；参数写在环境变量 %s 里。",
			"Command-line tool (absolute path) of the ACP agent to connect. There is no preset; it cannot start without this. Put its arguments in the %s environment variable.",
		).with(args)
	}
	return harnessTexts{
		group: &group,
		enabled: both(
			"打开后在这台设备上提供 %s；关掉就停掉它的运行时，它自己保存的会话不受影响。",
			"Turning this on offers %s on this device; turning it off stops its runtime. The sessions it keeps itself are not affected.",
		).with(name),
		cliPath: cliPath,
		env: both(
			"只给 %s 的运行时：代理、接口地址、密钥等。优先于启动服务的进程自己的环境，也优先于环境文件（状态目录下的 env）。",
			"Only for the %s runtime: proxy, API endpoint, keys and so on. These take precedence over the environment of the process that started the service and over the environment file (env in the state directory).",
		).with(name),
	}
}

// Pi 的审批开关。说明里两条限制是给用户的原话：覆盖不到子代理，不是安全边界。
func piApprovalsSetting(c configuration, group string) settingSpec {
	return settingSpec{
		Key: piApprovalsKey, Group: group, Type: settingBoolean, Scope: harnessScope("pi"), Restart: restartHarness,
		Default: c.defaultPiApprovals(), Title: both("动手之前先问", "Ask before acting"),
		Description: both(
			"打开后，Pi 在主会话里运行命令、写文件、改文件、调用别的有副作用的工具之前先来问你，等你答复了才继续；读文件、搜索这类不问。"+
				"两条限制：子代理里的操作不问（启动子代理本身会问一次）；这只是让你先看一眼，不是安全边界，Pi 没有沙箱，放行之后做什么不受约束。"+
				"关着时一概不问。",
			"While on, Pi asks you before it runs a command, writes or edits a file, or calls another tool with side effects in the main session, and waits for your answer. Reading files and searching are not asked about. "+
				"Two limits: operations inside subagents are not asked about (starting a subagent is asked once), and this is a chance to look first, not a security boundary: Pi has no sandbox, and nothing constrains what an approved operation does. "+
				"While off, Pi never asks.",
		),
	}
}

func buildSettingsSchema(c configuration) settingsSchema {
	schema := settingsSchema{}
	low, high := 1, 65535
	for _, id := range knownHarnesses {
		name, group := harnessNames[id], "harness."+id
		texts := harnessSettingTexts(id)
		schema.Groups = append(schema.Groups, settingGroup{
			ID: group, Title: verbatim(name), Scope: harnessScope(id), Description: texts.group,
		})
		schema.Settings = append(schema.Settings,
			settingSpec{
				Key: enabledKey(id), Group: group, Type: settingBoolean, Scope: harnessScope(id), Restart: restartHarness,
				Role: roleEnable, Default: c.defaultEnabled(id), Title: both("启用", "Enabled"), Description: texts.enabled,
			},
			settingSpec{
				Key: cliPathKey(id), Group: group, Type: settingPath, Scope: harnessScope(id), Restart: restartHarness,
				Default: "", Title: both("命令行路径", "CLI path"), Description: texts.cliPath,
			},
			settingSpec{
				Key: envKey(id), Group: group, Type: settingEnv, Scope: harnessScope(id), Restart: restartHarness,
				Default: []envEntry{}, Title: both("环境变量", "Environment variables"), Description: texts.env,
			},
		)
		if id == "pi" {
			schema.Settings = append(schema.Settings, piApprovalsSetting(c, group))
		}
	}
	description := both(
		"给官方 Codex 桌面端连的内置 SSH 服务，只监听本机的回环地址。Litch 自己不经过它们。",
		"Built-in SSH servers for the official Codex desktop app, listening on the loopback address only. Litch itself does not use them.",
	)
	schema.Groups = append(schema.Groups, settingGroup{
		ID: "ssh", Scope: deviceScope, Description: &description,
		Title: both("给 Codex 桌面端的 SSH 入口", "SSH entries for the Codex desktop app"),
	})
	for _, id := range adapterHarnesses {
		name := harnessNames[id]
		schema.Settings = append(schema.Settings,
			settingSpec{
				Key: sshEnabledKey(id), Group: "ssh", Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
				Default: !c.sshDisabled,
				Title:   both("%s 入口", "%s entry").with(name),
				Description: both(
					"开着时 Codex 桌面端可以经 SSH 连到 %s。关掉会断开它在这个入口上现有的连接。",
					"While on, the Codex desktop app can reach %s over SSH. Turning it off drops the connections it has on this entry.",
				).with(name),
			},
			settingSpec{
				Key: sshPortKey(id), Group: "ssh", Type: settingInteger, Scope: deviceScope, Restart: restartNone,
				Default: c.defaultPort(id), Minimum: &low, Maximum: &high,
				Title: both("%s 入口的端口", "%s entry port").with(name),
				Description: both(
					"只监听 127.0.0.1。各入口的端口不能相同；改了之后入口换到新端口上，现有的连接会断开，Codex 桌面端那边的 ssh 配置也要跟着改。",
					"Listens on 127.0.0.1 only. Each entry needs its own port. After a change the entry moves to the new port, existing connections drop, and the ssh config on the Codex desktop side has to follow.",
				),
			},
		)
	}
	group, specs := processSettings()
	schema.Groups = append(schema.Groups, group)
	schema.Settings = append(schema.Settings, specs...)
	group, specs = taskSettings()
	schema.Groups = append(schema.Groups, group)
	schema.Settings = append(schema.Settings, specs...)
	return schema
}
