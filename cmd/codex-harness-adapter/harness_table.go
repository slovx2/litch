package main

import (
	"path/filepath"
	"runtime"
	"strings"
)

// 这台设备上受管的全部 harness 的登记表。加一个 harness：在 harnessTable 里加一行，
// 再在 packages/protocol/src/harness-identity.json 里登记它的名字和徽标。
// 端口参数、--harness 的取值、帮助文字、默认启用、入口路径、固定的环境变量、设置项、诊断里的提示都从这张表取；
// 能由 Litch 装的再挂上官方装法（install，harness_install.go）。

// 设置里没写过“是否启用”、也没有用 --harness 只选一个时，这个 harness 起不起。
const (
	// 总是启用（Claude Code、Pi）
	enableAlways = iota
	// 检测到这台设备装了才启用（dsh、OpenCode、原生 codex）
	enableWhenInstalled
	// 默认不启用，要在设置里打开（经 ACP 接的 Gemini CLI、Qwen Code、自填命令的 ACP）
	enableOptIn
)

type harnessSpec struct {
	id string
	// 引擎包的目录名：入口在 packages/<pkg>/dist/<pkg>/src/adapter.mjs。原生 codex 没有。
	pkg string
	// 全部启动时它的 SSH 端口参数（不带 --）和默认端口。原生 codex 没有 SSH 入口，这两项都空着。
	portFlag    string
	defaultPort int
	// 命令行路径这一项落到哪个环境变量上：引擎按它找用户装的命令行。原生 codex 不经环境变量（locateCodex）。
	cliVariable string
	// 适配器给它的状态目录落到哪个环境变量上（固定变量，设置里不许改）。
	homeVariable string
	// 在 PATH 里找它的命令行用的名字（不带 Windows 的扩展名），和 PATH 之外还要看的位置（相对用户主目录）。
	// 只有按“装了才启用”判断的 harness 需要。
	commands  []string
	fallbacks []string
	enable    int
	// 实验性的：没装时的提示里多交代一句它为什么没有照常去试。
	experimental bool
	// 由通用 ACP 引擎扮演：起它时带 CHA_ACP_AGENT=<标识>，引擎据此找预设（packages/protocol/src/acp-agents.json）。
	acp bool
	// 没有预设的命令：不给命令行路径就算没装，启用了也不去试（自填命令的 acp）。
	needsCLI bool
	// 原生 codex：不是适配器的引擎，没有 SSH 入口，环境不加固定变量（native_codex.go）。
	native bool
	// 官方装法、验证版、最低版本（harness_install.go）。nil 是不能由 Litch 装（自填命令的 acp）。
	install *installSpec
}

// 通用 ACP 引擎从这个变量知道自己这次扮演哪个标识（gemini、qwen、acp 共用一个引擎包）。
const acpAgentVariable = "CHA_ACP_AGENT"

// 顺序就是报给客户端的顺序，也是全部启动时各入口的顺序。
var harnessTable = []harnessSpec{
	{
		id: "claude-code", pkg: "claude", portFlag: "claude-port", defaultPort: 7331, cliVariable: "CHA_CLAUDE_CLI", homeVariable: "CHA_CLAUDE_HOME",
		// 官方安装脚本（install.sh、install.ps1）装在 ~/.local/bin，常常不在 PATH 上：PATH 里找不到时由命令行找到它、
		// 经 CHA_CLAUDE_CLI 交给引擎（configuration.environment），引擎自己只看这个变量和 PATH
		commands: []string{"claude"}, fallbacks: []string{filepath.Join(".local", "bin", "claude")}, enable: enableAlways,
		install: claudeInstall,
	},
	{id: "pi", pkg: "pi", portFlag: "pi-port", defaultPort: 7332, cliVariable: "PI_CLI", homeVariable: "CHA_PI_HOME", enable: enableAlways, install: piInstall},
	{
		id: "dsh", pkg: "dsh", portFlag: "dsh-port", defaultPort: 7333, cliVariable: "CHA_DSH_CLI", homeVariable: "CHA_DSH_HOME",
		commands: []string{"dsh"}, enable: enableWhenInstalled, experimental: true, install: dshInstall,
	},
	{
		id: "opencode", pkg: "opencode", portFlag: "opencode-port", defaultPort: 7334, cliVariable: "CHA_OPENCODE_CLI", homeVariable: "CHA_OPENCODE_HOME",
		// 官方安装脚本装在 ~/.opencode/bin，不一定进了 PATH（引擎找命令行的次序与此相同）
		commands: []string{"opencode"}, fallbacks: []string{filepath.Join(".opencode", "bin", "opencode")}, enable: enableWhenInstalled,
		install: opencodeInstall,
	},
	{id: "gemini", pkg: "acp", portFlag: "gemini-port", defaultPort: 7335, cliVariable: "CHA_GEMINI_CLI", homeVariable: "CHA_GEMINI_HOME", enable: enableOptIn, acp: true, install: geminiInstall},
	{id: "qwen", pkg: "acp", portFlag: "qwen-port", defaultPort: 7336, cliVariable: "CHA_QWEN_CLI", homeVariable: "CHA_QWEN_HOME", enable: enableOptIn, acp: true, install: qwenInstall},
	{id: "acp", pkg: "acp", portFlag: "acp-port", defaultPort: 7337, cliVariable: "CHA_ACP_CLI", homeVariable: "CHA_ACP_HOME", enable: enableOptIn, acp: true, needsCLI: true},
	{id: nativeCodex, commands: []string{"codex"}, enable: enableWhenInstalled, native: true, install: codexInstall},
}

func harnessByID(id string) (harnessSpec, bool) {
	for _, spec := range harnessTable {
		if spec.id == id {
			return spec, true
		}
	}
	return harnessSpec{}, false
}

// 不认识的标识按空的登记算：没有端口、没有变量，默认不启用。
func specOf(id string) harnessSpec {
	spec, known := harnessByID(id)
	if !known {
		return harnessSpec{id: id, enable: enableOptIn}
	}
	return spec
}

// 适配器自己的引擎：各有一个 Node 运行时，各有一个给官方桌面端的 SSH 入口。
// 探测“有没有别的服务在这个状态目录上跑”时把它们都看一遍，不管这次选了哪个、装没装。
var adapterHarnesses = func() []string {
	ids := []string{}
	for _, spec := range harnessTable {
		if !spec.native {
			ids = append(ids, spec.id)
		}
	}
	return ids
}()

// 这台设备上受管的全部 harness，顺序就是报给客户端的顺序：适配器的引擎，加上原生 codex（native_codex.go）。
var knownHarnesses = func() []string {
	ids := []string{}
	for _, spec := range harnessTable {
		ids = append(ids, spec.id)
	}
	return ids
}()

// 这个 harness 有没有给官方桌面端的 SSH 入口。原生 codex 没有。
func hasSSHEntry(id string) bool { return !specOf(id).native }

// 命令行路径这一项落到哪个环境变量上。原生 codex 不在这张表里：它的路径由服务自己读（locateCodex），不经环境变量。
var harnessCLIVariable = func() map[string]string {
	variables := map[string]string{}
	for _, spec := range harnessTable {
		if spec.cliVariable != "" {
			variables[spec.id] = spec.cliVariable
		}
	}
	return variables
}()

// 这个 harness 装没装：设置了它的命令行变量（设置里的命令行路径也落到这个变量上）就认为用户要用它
// （路径无效会在启动时告警），否则在现行环境的 PATH 里找，再看登记的固定位置。版本够不够由引擎启动前的检查判断。
func cliInstalled(c configuration, spec harnessSpec) bool {
	env := map[string]string{}
	for _, entry := range c.environment() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	if spec.cliVariable != "" && strings.TrimSpace(env[spec.cliVariable]) != "" {
		return true
	}
	search := env["PATH"]
	if search == "" {
		search = env["Path"]
	}
	if commandOnPath(search, spec) != "" {
		return true
	}
	home := env["HOME"]
	if home == "" {
		home = env["USERPROFILE"]
	}
	return fallbackCLI(home, spec) != ""
}

// PATH 里登记的命令名（Windows 上加 .exe、.cmd）找到的第一个，没有是空串。
func commandOnPath(search string, spec harnessSpec) string {
	names := []string{}
	for _, command := range spec.commands {
		if runtime.GOOS == "windows" {
			names = append(names, command+".exe", command+".cmd")
		}
		names = append(names, command)
	}
	if len(names) == 0 {
		return ""
	}
	return executableOnPath(search, names)
}

// withFallbackCLI：这个 harness 的命令行变量没给、PATH 里也没有它的命令，而登记的固定位置有能执行的，
// 就把那个路径作为命令行变量补进给它的环境。引擎只按这个变量和 PATH 找命令行，不认这些固定位置；
// 版本一览（locateCLI）读的也是同一个变量，两边找到的就是同一份。
func withFallbackCLI(id string, env []string) []string {
	spec := specOf(id)
	if spec.native || spec.cliVariable == "" || len(spec.fallbacks) == 0 {
		return env
	}
	values := map[string]string{}
	for _, entry := range env {
		name, value, _ := strings.Cut(entry, "=")
		values[name] = value
	}
	if strings.TrimSpace(values[spec.cliVariable]) != "" {
		return env
	}
	search := values["PATH"]
	if search == "" {
		search = values["Path"]
	}
	if commandOnPath(search, spec) != "" {
		return env
	}
	home := values["HOME"]
	if home == "" {
		home = values["USERPROFILE"]
	}
	path := fallbackCLI(home, spec)
	if path == "" {
		return env
	}
	result := make([]string, 0, len(env)+1)
	for _, entry := range env {
		// 去掉原来那条空值的，免得同名变量出现两次
		if name, _, _ := strings.Cut(entry, "="); name != spec.cliVariable {
			result = append(result, entry)
		}
	}
	return append(result, spec.cliVariable+"="+path)
}

// 登记的固定位置（相对主目录）里第一个能执行的命令行，没有是空串。Windows 上依次试 .exe、.cmd 和原名。
func fallbackCLI(home string, spec harnessSpec) string {
	if home == "" {
		return ""
	}
	for _, fallback := range spec.fallbacks {
		path := filepath.Join(home, fallback)
		variants := []string{filepath.Base(path)}
		if runtime.GOOS == "windows" {
			variants = append([]string{variants[0] + ".exe", variants[0] + ".cmd"}, variants...)
		}
		if found := executableOnPath(filepath.Dir(path), variants); found != "" {
			return found
		}
	}
	return ""
}

// 与适配器定位 dsh 的规则一致。测试里会换成假的。
var dshInstalled = func(c configuration) bool { return cliInstalled(c, specOf("dsh")) }

// 与 OpenCode 引擎定位 opencode 的规则一致：CHA_OPENCODE_CLI，PATH 里的 opencode，再看 ~/.opencode/bin/opencode。测试里会换成假的。
var opencodeInstalled = func(c configuration) bool { return cliInstalled(c, specOf("opencode")) }

// 按“装了才启用”判断的 harness 装没装。经包级变量调用，测试换掉检测时这里跟着换。
func (c configuration) installed(id string) bool {
	switch id {
	case "dsh":
		return dshInstalled(c)
	case "opencode":
		return opencodeInstalled(c)
	case nativeCodex:
		return codexInstalled(c)
	}
	return cliInstalled(c, specOf(id))
}

// 没有预设命令的 harness（自填命令的 acp）缺了命令行路径。这时启用了也不去试，直接报没装。
func (c configuration) lacksCLI() bool {
	spec := specOf(c.harness)
	return spec.needsCLI && strings.TrimSpace(c.environmentValue(spec.cliVariable)) == ""
}
