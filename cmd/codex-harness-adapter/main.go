package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/slovx2/litch/internal/hostplatform"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
)

type configuration struct {
	harness, home, root, node string
	port                      int
	// 全部启动时各入口的 SSH 端口（--claude-port 等，按登记表的 portFlag），键是 harness 标识。
	// 只经 portOf、setPort 读写：setPort 换一份新表，不改别的配置副本手里的那一份。
	ports   map[string]int
	userEnv map[string]string
	// 给 Codex 桌面端的内置 SSH 入口默认开着；--ssh=off 时一个都不起，不占端口。
	sshDisabled bool
	// 设备的设置。启动参数里的端口、--ssh、--harness 是设置里没写过时的默认值，写过就以设置为准。
	// nil 表示没有设置可读，全用默认值。
	settings *settingsStore
	// 设置里只给这个 harness 的环境变量（含命令行路径那一项），由 forHarness 填上。
	settingsEnv map[string]string
	// SSH 入口的状况变了时调用，常驻服务据此把最新的状况告诉设备进程。可以为 nil。
	statusChanged func()
	// 这份常驻服务是 device-start 按需拉起、脱离出去的（--detached，只由 device-start 带上）。
	// 前台运行的、由 brew services 或 systemd 这类管着的不带：它们的生死另有人管，客户端不替它们换版本。
	detached bool
	// 仅 device-start 显式登记该状态目录为本机服务；普通 SSH 启动不登记。
	localService bool
	// 启动参数里“设置没写过时的默认值”那一部分（--ssh、各端口、--harness），照命令行给的原样记着，
	// 不掺设置里的值。device-start 照它拉起常驻服务，服务把它报出来，换版本重新拉起时原样带上。
	launch []string
	// device-stop --if-idle：有回合、属于设备的终端在跑，或者有客户端连着时不停。
	ifIdle bool
	// 官方桌面端经 SSH 入口连着几条。常驻服务据此判断忙不忙；可以为 nil（单独 serve 一个入口时没人问）。
	desktops *atomic.Int64
}

// 调用方要按退出码区分情况的错误。别的错误一律是退出码 1。
type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string { return e.err.Error() }
func (e *exitError) Unwrap() error { return e.err }

func exitCode(err error) int {
	var coded *exitError
	if errors.As(err, &coded) {
		return coded.code
	}
	return 1
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "pty-bridge" {
		os.Exit(runPtyBridge(os.Args[2:]))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	args := os.Args[1:]
	// 按短名 litch-machine 调用的就是 machine 子命令（machine.go）
	if strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") == machineShortName {
		args = append([]string{"machine"}, args...)
	}
	if err := run(ctx, args); err != nil {
		// 自己已经把话说完了的（machine 子命令）只带退出码
		if err.Error() != "" {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(exitCode(err))
	}
}

// 两种语言的第一行都原样保留子命令清单，Homebrew 配方的自检按它匹配。
func usage() string {
	ports, ids := []string{}, strings.Join(adapterHarnesses, "|")
	for _, spec := range harnessTable {
		if spec.portFlag != "" {
			ports = append(ports, fmt.Sprintf("--%s %d", spec.portFlag, spec.defaultPort))
		}
	}
	return fmt.Sprintf(tr(
		"用法: codex-harness-adapter start|init|serve|ssh-config|doctor [选项]\n"+
			"start: 自动初始化并启动可用的 Claude Code 和 Pi；可用 --harness claude-code|pi 仅启动一个\n"+
			"全部启动端口: %[1]s\n"+
			"单入口端口: --harness %[2]s --port PORT\n"+
			"实验入口 dsh（DeepSeek Harness）: 检测到本机装有 dsh 时随全部启动，没装时不提示\n"+
			"OpenCode: 检测到本机装有 opencode（PATH 里，或 ~/.opencode/bin/opencode）时随全部启动，没装时不提示；可用 CHA_OPENCODE_CLI 指定路径\n"+
			"ACP（Gemini CLI、Qwen Code、自填命令的 acp）: 默认不启用，在 Litch 的设置里打开；命令和参数可用 CHA_<标识>_CLI、CHA_<标识>_ARGS 覆盖，acp 必须给 CHA_ACP_CLI\n"+
			"原生 Codex: 检测到本机装有 codex 时启用（在 Litch 的设置里可以关掉），用它起一个 app-server，只经聚合面提供，没有 SSH 入口\n"+
			"公共选项: --home DIR --node PATH --root DIR\n"+
			"SSH 入口: --ssh=on|off（默认 on）；off 时不启动给 Codex 桌面端的内置 SSH 服务，不占端口\n"+
			"给 Litch 客户端: version 打印版本号；device-start 让常驻服务在后台运行（已在运行就直接成功）；device-proxy 把标准输入输出接到聚合面\n"+
			"操作用户的 Litch 桌面端: machine（短名 litch-machine）经设备服务请连着的 Litch 执行命令、读写文件，详见 litch-machine --help\n"+
			"绑到手机: pair 在终端里画二维码，手机扫码后登记自己的钥匙（不用桌面端），详见 pair --help；pair-enroll 是配对时一次性钥匙的强制命令，不直接用\n"+
			"配置 Litch: config <参数…> 把参数原样交给连着的 Litch 桌面端执行（要桌面端开着），--json 出结构化结果；有哪些操作见 config --help\n"+
			"停掉常驻服务: device-stop 请它平稳停下并等它退出（没在运行也算成功）；加 --if-idle 时，有回合或终端在跑、有客户端连着就不停，并说明是哪一种\n"+
			"环境文件: <home>/env，每行 KEY=VALUE，前台和后台服务启动都会读取\n"+
			"输出语言: 跟随系统语言；用 CHA_LANG=zh-CN 或 CHA_LANG=en 指定，可写在环境文件里\n"+
			"首次连接: Codex 设置 → 连接 → SSH → 添加；可选将输出的配置加入 ~/.ssh/config；Ctrl-C 停止全部入口",
		"Usage: codex-harness-adapter start|init|serve|ssh-config|doctor [options]\n"+
			"start: initialise and start every available harness (Claude Code and Pi); use --harness claude-code|pi to start only one\n"+
			"Ports when starting all: %[1]s\n"+
			"Port for a single entry: --harness %[2]s --port PORT\n"+
			"Experimental dsh entry (DeepSeek Harness): started with the others when dsh is installed; silent when it is not\n"+
			"OpenCode: started with the others when opencode is installed (on PATH, or ~/.opencode/bin/opencode); silent when it is not; set CHA_OPENCODE_CLI to point to it\n"+
			"ACP (Gemini CLI, Qwen Code, and acp with a command of your own): off by default, turn them on in Litch's settings; override the command and arguments with CHA_<ID>_CLI and CHA_<ID>_ARGS; acp needs CHA_ACP_CLI\n"+
			"Native Codex: on when codex is installed on this machine (it can be turned off in Litch's settings); an app-server is started with it, offered through the aggregate endpoint only, with no SSH entry\n"+
			"Common options: --home DIR --node PATH --root DIR\n"+
			"SSH entries: --ssh=on|off (default on); off starts none of the built-in SSH servers for the Codex desktop app and takes no port\n"+
			"For the Litch client: version prints the version; device-start keeps the service running in the background (succeeds at once if it already is); device-proxy connects stdin and stdout to the aggregate endpoint\n"+
			"Operating the user's Litch desktop: machine (short name litch-machine) asks the connected Litch to run commands and read or write files through the device service; see litch-machine --help\n"+
			"Pairing a phone: pair draws a QR code in the terminal and the phone enrolls a key of its own (no desktop needed); see pair --help. pair-enroll is the forced command of the one-time pairing key, not for direct use\n"+
			"Configuring Litch: config <arguments…> hands the arguments to the connected Litch desktop app to carry out (the desktop must be open); --json gives a structured result; config --help lists the operations\n"+
			"Stopping the service: device-stop asks it to shut down cleanly and waits for it to exit (succeeds when nothing is running); with --if-idle it leaves the service alone while a turn or a terminal is running or a client is connected, and says which\n"+
			"Environment file: <home>/env, one KEY=VALUE per line, read by foreground runs and by the background service\n"+
			"Output language: follows the system language; set CHA_LANG=zh-CN or CHA_LANG=en to choose, in the environment file if you like\n"+
			"First connection: Codex Settings → Connections → SSH → Add; optionally add the printed config to ~/.ssh/config; Ctrl-C stops every entry",
	), strings.Join(ports, " "), ids)
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		fmt.Println(usage())
		return nil
	}
	if args[0] == "entry" {
		return runEntry(ctx, args[1:])
	}
	if args[0] == "version" || args[0] == "--version" {
		return runVersion(args[1:])
	}
	if args[0] == "machine" {
		return runMachine(ctx, args[1:])
	}
	if args[0] == "chrome-host" {
		return runChromeHost(ctx, args[1:])
	}
	if args[0] == "pair" {
		return runPair(ctx, args[1:])
	}
	if args[0] == "pair-enroll" {
		return runPairEnroll(ctx, args[1:])
	}
	if args[0] == "config" {
		return runConfig(ctx, args[1:])
	}
	command := args[0]
	switch command {
	case "start", "init", "serve", "ssh-config", "doctor", "device-start", "device-stop", "device-proxy":
	default:
		return fmt.Errorf(tr("未知命令: %s", "unknown command: %s"), command)
	}
	cfg, err := parseConfiguration(args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if cfg.localService && command != "device-start" {
		return errors.New(tr("--local-service 只用于 device-start", "--local-service is only valid for device-start"))
	}
	// device-start 只是把参数原样交给它拉起的 start，device-stop 只是请服务自己停，device-proxy 只转发字节，都用不着设置。
	if command != "device-start" && command != "device-stop" && command != "device-proxy" {
		if cfg.settings, err = loadSettings(cfg.home); err != nil {
			return err
		}
		if cfg.harness != "" {
			cfg = cfg.forHarness(cfg.harness)
		}
	}
	switch command {
	case "start":
		return start(ctx, cfg)
	case "init":
		for _, entry := range cfg.entries() {
			if err := initialize(entry); err != nil {
				return err
			}
		}
		return nil
	case "ssh-config":
		var failures []error
		printed := false
		for _, entry := range cfg.entries() {
			if err := printSSHConfig(entry); err != nil {
				failures = append(failures, fmt.Errorf("%s: %w", entry.harness, err))
				fmt.Fprintf(os.Stderr, tr("警告：跳过 %s，请先启动或初始化此入口: %v\n", "Warning: skipping %s; start or initialise this entry first: %v\n"), entry.harness, err)
				continue
			}
			printed = true
		}
		if !printed {
			return errors.Join(failures...)
		}
		return nil
	case "serve":
		return serve(ctx, cfg)
	case "device-start":
		return deviceStart(ctx, cfg)
	case "device-stop":
		return deviceStop(ctx, cfg)
	case "device-proxy":
		return deviceProxy(ctx, cfg)
	case "doctor":
		if cfg.harness != "" {
			return doctor(ctx, cfg)
		}
		var failures []error
		for _, entry := range cfg.entries() {
			failures = append(failures, doctor(ctx, entry))
		}
		return errors.Join(failures...)
	}
	return nil
}

func parseConfiguration(args []string) (configuration, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return configuration{}, err
	}
	root, err := executableRoot()
	if err != nil {
		return configuration{}, err
	}
	flags := flag.NewFlagSet("codex-harness-adapter", flag.ContinueOnError)
	cfg := configuration{}
	flags.StringVar(&cfg.harness, "harness", "", strings.Join(adapterHarnesses, tr("、", ", ")))
	flags.StringVar(&cfg.home, "home", filepath.Join(home, ".codex-harness-adapter"), tr("适配器状态根目录", "root directory for adapter state"))
	flags.StringVar(&cfg.root, "root", root, tr("适配器源码根目录", "root directory of the adapter source"))
	flags.StringVar(&cfg.node, "node", "node", tr("Node 可执行文件；不给时先用随这份适配器带的那一份，没有才是 PATH 里的 node", "Node executable; when omitted, the one bundled with this adapter if there is one, otherwise node on PATH"))
	flags.IntVar(&cfg.port, "port", 0, tr("回环 SSH 端口", "loopback SSH port"))
	given := map[string]*int{}
	for _, spec := range harnessTable {
		if spec.portFlag != "" {
			given[spec.id] = flags.Int(spec.portFlag, spec.defaultPort, fmt.Sprintf(tr("全部启动时 %s 的 SSH 端口", "%s SSH port when starting all entries"), harnessNames[spec.id]))
		}
	}
	sshMode := "on"
	flags.StringVar(&sshMode, "ssh", sshMode, tr("给 Codex 桌面端的内置 SSH 入口：on 或 off", "built-in SSH entries for the Codex desktop app: on or off"))
	flags.BoolVar(&cfg.ifIdle, "if-idle", false, tr("device-stop：有回合或终端在跑、有客户端连着时不停", "device-stop: leave the service alone while a turn or a terminal is running or a client is connected"))
	flags.BoolVar(&cfg.detached, "detached", false, tr("内部使用：device-start 拉起常驻服务时带上", "internal: set by device-start on the service it launches"))
	flags.BoolVar(&cfg.localService, "local-service", false, tr("device-start：将该服务登记为本机设备并启用本机电源设置", "device-start: register this service as local and make local power settings available"))
	if err := flags.Parse(args); err != nil {
		return cfg, err
	}
	if flags.NArg() != 0 {
		return cfg, errors.New(tr("不接受位置参数", "positional arguments are not accepted"))
	}
	switch sshMode {
	case "on":
	case "off":
		cfg.sshDisabled = true
	default:
		return cfg, errors.New(tr("--ssh 只能是 on 或 off", "--ssh must be on or off"))
	}
	cfg.ports = map[string]int{}
	for id, port := range given {
		cfg.ports[id] = *port
	}
	if spec, known := harnessByID(cfg.harness); cfg.harness != "" && (!known || spec.native) {
		return cfg, fmt.Errorf(tr("harness 必须为 %s", "harness must be %s"), strings.Join(adapterHarnesses, tr("、", ", ")))
	}
	if cfg.harness == "" && cfg.port != 0 {
		return cfg, errors.New(tr("--port 需要指定 --harness；全部启动请用 --claude-port 和 --pi-port", "--port requires --harness; when starting all entries use --claude-port and --pi-port"))
	}
	if err := cfg.checkPorts(); err != nil {
		return cfg, err
	}
	if cfg.port == 0 {
		// 全部启动时这一项只是占位，沿用 Claude Code 的端口，和以前一样
		id := cfg.harness
		if id == "" {
			id = harnessTable[0].id
		}
		cfg.port = cfg.portOf(id)
	}
	if cfg.port < 1 || cfg.port > 65535 {
		return cfg, errors.New(tr("端口必须为 1 到 65535", "the port must be between 1 and 65535"))
	}
	cfg.home, err = filepath.Abs(cfg.home)
	if err != nil {
		return cfg, err
	}
	if cfg.root, err = filepath.Abs(cfg.root); err != nil {
		return cfg, err
	}
	nodeGiven := false
	flags.Visit(func(given *flag.Flag) { nodeGiven = nodeGiven || given.Name == "node" })
	if !nodeGiven {
		cfg.node = defaultNode(cfg.root)
	}
	cfg.launch = cfg.launchOptions()
	if cfg.userEnv, err = loadUserEnvironment(cfg.home); err != nil {
		return cfg, err
	}
	applyUserLanguage(cfg.userEnv)
	applyUserLogLimits(cfg.userEnv)
	return cfg, nil
}

// 不带 --harness 时 init、ssh-config、doctor 照看的入口：总是启用的（Claude Code、Pi），检测到装了的（dsh、OpenCode），
// 加上设置里明确启用了的（默认不启用的 ACP 那几个）。没装的不告警也不占端口，其余入口不受影响。
// 装了但版本过低或启动失败时，与别的入口一样只告警。
func (c configuration) entries() []configuration {
	if c.harness != "" {
		return []configuration{c.forHarness(c.harness)}
	}
	entries := []configuration{}
	for _, spec := range harnessTable {
		if spec.native {
			continue
		}
		entry := c.forHarness(spec.id)
		wanted := spec.enable == enableAlways || c.settings.boolean(enabledKey(spec.id), false)
		if spec.enable == enableWhenInstalled && !wanted {
			wanted = entry.installed(spec.id)
		}
		if wanted {
			entries = append(entries, entry)
		}
	}
	return entries
}

// 全部启动时一个入口的端口。--harness 只选一个时它用 --port（没给就用它自己那一项）。
func (c configuration) portOf(id string) int {
	if port, given := c.ports[id]; given {
		return port
	}
	return specOf(id).defaultPort
}

func (c *configuration) setPort(id string, port int) {
	ports := map[string]int{}
	for name, value := range c.ports {
		ports[name] = value
	}
	ports[id] = port
	c.ports = ports
}

// 各入口的端口要在 1 到 65535 之间，彼此不同。
func (c configuration) checkPorts() error {
	seen := map[int]string{}
	for _, spec := range harnessTable {
		if spec.portFlag == "" {
			continue
		}
		port := c.portOf(spec.id)
		if port < 1 || port > 65535 {
			return fmt.Errorf(tr("--%s 必须在 1 到 65535 之间", "--%s must be between 1 and 65535"), spec.portFlag)
		}
		if other, taken := seen[port]; taken {
			return fmt.Errorf(tr("--%s 和 --%s 的端口不能相同", "--%s and --%s must use different ports"), other, spec.portFlag)
		}
		seen[port] = spec.portFlag
	}
	return nil
}

func (c configuration) directory() string { return filepath.Join(c.home, c.harness) }
func (c configuration) socket() string    { return hostplatform.SocketPath(c.directory()) }
func (c configuration) adapter() string {
	name := specOf(c.harness).pkg
	return filepath.Join(c.root, "packages", name, "dist", name, "src", "adapter.mjs")
}

// 命令行把自己的路径放在这个变量里，交给它起的运行时和设备进程：带终端的命令和进程要回头用这一份的
// pty-bridge 子命令（packages/shared/src/adapter-cli.mts 读，读走就从它自己的环境里拿掉，不再往下传）。
// 取不到路径就不给，那边会从自己文件的位置往上找 bin/ 里的那一份。
const adapterCLIEnvironment = "CHA_ADAPTER_CLI"

var adapterCLIPath = sync.OnceValue(func() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
})

// 优先级：适配器固定变量 > 设置里给这个 harness 的 > 启动进程已有的 > 环境文件。
// 原生 codex 没有固定变量：它的数据目录是用户自己的，CODEX_HOME 由用户的环境（或者设置）说了算。
func (c configuration) environment() []string {
	return withFallbackCLI(c.harness, c.baseEnvironment())
}

// 不含默认安装位置补出的 CLI 变量，用于准确标记选择来源。
func (c configuration) baseEnvironment() []string {
	values := map[string]string{
		"CODEX_HOME":              filepath.Join(c.directory(), "codex"),
		"CHA_CLAUDE_IDLE_EXIT_MS": "0",
	}
	// 每个引擎的状态目录变量都给成这个入口的目录，不让外面的同名变量漏进来。
	for _, spec := range harnessTable {
		if spec.homeVariable != "" {
			values[spec.homeVariable] = c.directory()
		}
	}
	// 通用 ACP 引擎一份代码扮演几个 harness，靠这个变量知道这一次是哪个
	if specOf(c.harness).acp {
		values[acpAgentVariable] = c.harness
	}
	if path := adapterCLIPath(); path != "" {
		values[adapterCLIEnvironment] = path
	}
	// 入口的日志目录（logs/<harness>）：引擎一启动就从自己的环境里拿走，它跑的命令看不到（logs.go）
	values[logDirEnvironment] = c.harnessLogDirectory()
	if c.native() {
		values = map[string]string{}
	}
	// 设备服务的套接字：harness 跑的命令继承得到，litch-machine 靠它找到不在默认状态目录下的服务。
	// 原生 codex 也给（它没有别的固定变量，这一个不碰它的数据），它的 shell 命令照它的环境策略继承
	values[deviceSocketEnvironment] = c.deviceSocket()
	result := []string{}
	present := map[string]bool{}
	for name, value := range c.settingsEnv {
		if _, fixed := values[name]; !fixed {
			present[name] = true
			result = append(result, name+"="+value)
		}
	}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, fixed := values[name]; fixed || isMachineThreadVariable(name) {
			continue
		}
		if _, configured := c.settingsEnv[name]; configured {
			continue
		}
		present[name] = true
		result = append(result, entry)
	}
	for name, value := range c.userEnv {
		if _, fixed := values[name]; !fixed && !present[name] && !isMachineThreadVariable(name) {
			result = append(result, name+"="+value)
		}
	}
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result
}

func doctor(ctx context.Context, c configuration) error {
	if runtime.GOOS == "windows" && c.harness == "claude-code" {
		fmt.Println(tr("Windows 上的 Claude 命令执行需要显式选择完全访问；需要系统沙箱时请使用 WSL2。", "On Windows, Claude can only run commands after you explicitly choose full access; use WSL2 if you need the system sandbox."))
	}
	for _, check := range harnessChecks(ctx, c) {
		if check.Status != "failed" {
			continue
		}
		if check.ID == "shell" {
			return check.err
		}
		return fmt.Errorf("[%s] %w", c.harness, check.err)
	}
	fmt.Printf(tr("[%s] 检查通过：引擎与终端可用。\n", "[%s] Check passed: the engine and the terminal are available.\n"), c.harness)
	fmt.Println(tr("下一步：运行 npm start 并连接 Codex；模型登录和回复请在会话中确认。", "Next: run npm start and connect Codex; confirm model login and replies in a session."))
	return nil
}
