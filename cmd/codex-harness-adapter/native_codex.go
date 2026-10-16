package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 原生 codex：这台设备上用户自己装的 codex，作为又一个受管的 harness 接进聚合面（设计文档 03 第 12.2 节）。
// 它和适配器自己的三个引擎不一样的地方都收在这个文件里：
//   - 运行时不是适配器的 Node 进程，而是用户的 codex 起的一个 app-server，监听 <home>/codex/runtime.sock；
//   - 没有给官方桌面端的 SSH 入口：官方桌面端自己会连 codex，用不着我们转；
//   - 数据目录是用户自己的那一份（默认 ~/.codex，或者环境里的 CODEX_HOME）：会话、登录状态和用户在终端里
//     用的是同一份，这是有意的。适配器不往里写任何东西，也不替它定位置；
//   - 设置里没写过时，检测到这台设备装了 codex 就启用（和 dsh 一样），没装不算毛病；设置里关掉的照关。
//
// 不碰 codex 自己的常驻服务：不用 `codex app-server daemon`，也不连它数据目录里的那个控制套接字。
// 那是用户自己的服务，官方桌面端可能正用着。我们另起一个 app-server，听我们自己状态目录里的套接字。
const nativeCodex = "codex"

// 用户装的 codex 至少要这个版本。只设下限，更高的都收。依据：
//   - 仓库里的协议类型固定在这一版（protocol/versions.json 的 codexProtocol）。客户端和设备进程用到的方法与字段、
//     设备进程替它整理的能力声明里的每一位，都是对着这一版的结构定义和上游源码核对的；更早的版本没有核对过。
//   - 用到的方法在这一版都有。按上游的稳定版标签，其中出现得最晚的几样是：项目（project/*，0.149.0 起）、
//     按回合回退和设备侧队列（thread/revert、thread/queue/*，0.148.0 起）、分区与置顶（threadSection/*、
//     thread/section/move，0.147.0 起）、分叉时指定回合（lastTurnId，0.143.0 起）、权限档（permissionProfile/list、
//     thread/settings/update，0.133.0 起）、`app-server --listen unix://PATH`（0.125.0 起）。
//     只看方法的话 0.149.0 就够，取 0.157.1 是因为上一条。
//   - 同一个数据目录上有别的 codex 进程在用时，靠的是它按会话加的跨进程写入锁（0.146.0 起），不能低于那一版。
//
// 预发布版按版本号的先后比：0.162.0-alpha.1 比下限新，可以用；0.157.1-alpha.1 比下限旧，不行。
const minimumCodexVersion = "0.157.1"

// 读版本最多等这么久。
var codexVersionTimeout = 15 * time.Second

func (c configuration) native() bool { return c.harness == nativeCodex }

// 在一串目录里找第一个叫这些名字之一的可执行文件。
func executableOnPath(search string, names []string) string {
	for _, directory := range filepath.SplitList(search) {
		if directory == "" {
			continue
		}
		for _, name := range names {
			path := filepath.Join(directory, name)
			info, err := os.Stat(path)
			if err == nil && !info.IsDir() && (runtime.GOOS == "windows" || info.Mode()&0o111 != 0) {
				return path
			}
		}
	}
	return ""
}

// 现行环境（设置 > 启动进程 > 环境文件）里一个变量的值。
func (c configuration) environmentValue(names ...string) string {
	values := map[string]string{}
	for _, entry := range c.environment() {
		name, value, _ := strings.Cut(entry, "=")
		values[name] = value
	}
	for _, name := range names {
		if value := values[name]; value != "" {
			return value
		}
	}
	return ""
}

func codexFailure(c configuration, kind string, text bilingual) error {
	return diagnosticFailure(c, kind, text)
}

// 找用户装的 codex：设置里填了路径就用它，没填在 PATH 里找。
func locateCodex(c configuration) (string, error) {
	if path := c.settings.text(cliPathKey(nativeCodex)); path != "" {
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || (runtime.GOOS != "windows" && info.Mode()&0o111 == 0) {
			return "", codexFailure(c, stateNotInstalled, cliMissing(c))
		}
		return path, nil
	}
	if path := executableOnPath(c.environmentValue("PATH", "Path"), codexNames()); path != "" {
		return path, nil
	}
	return "", codexFailure(c, stateNotInstalled, cliMissing(c))
}

func codexNames() []string {
	if runtime.GOOS == "windows" {
		return []string{"codex.exe", "codex.cmd", "codex"}
	}
	return []string{"codex"}
}

// 设置里没写过启用与否时，照这个看装没装：填了命令行路径就算要用它（路径不对，启动时照 locateCodex 说），
// 没填就在现行环境的 PATH 里找，和 locateCodex 找的是同一处。
var codexInstalled = func(c configuration) bool {
	if c.settings.text(cliPathKey(nativeCodex)) != "" {
		return true
	}
	return executableOnPath(c.environmentValue("PATH", "Path"), codexNames()) != ""
}

var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?`)

// 按语义化版本的先后比两个版本号：负数是 a 旧，正数是 a 新。有一个认不出就返回 false。
func compareVersions(a, b string) (int, bool) {
	left, right := versionPattern.FindStringSubmatch(a), versionPattern.FindStringSubmatch(b)
	if left == nil || right == nil {
		return 0, false
	}
	for index := 1; index <= 3; index++ {
		x, _ := strconv.Atoi(left[index])
		y, _ := strconv.Atoi(right[index])
		if x != y {
			return x - y, true
		}
	}
	// 主版本号相同：没有预发布标记的是正式版，比带标记的新。
	if left[4] == "" || right[4] == "" {
		switch {
		case left[4] == right[4]:
			return 0, true
		case left[4] == "":
			return 1, true
		}
		return -1, true
	}
	xs, ys := strings.Split(left[4], "."), strings.Split(right[4], ".")
	for index := 0; index < len(xs) && index < len(ys); index++ {
		x, xErr := strconv.Atoi(xs[index])
		y, yErr := strconv.Atoi(ys[index])
		switch {
		case xErr == nil && yErr == nil:
			if x != y {
				return x - y, true
			}
		case xErr == nil:
			// 数字段比字母段旧。
			return -1, true
		case yErr == nil:
			return 1, true
		case xs[index] != ys[index]:
			return strings.Compare(xs[index], ys[index]), true
		}
	}
	return len(xs) - len(ys), true
}

// 找到 codex、读出版本、看够不够下限。原始输出只进这个 harness 的诊断日志。
func inspectCodex(ctx context.Context, c configuration) (path, version string, err error) {
	if runtime.GOOS == "windows" {
		return "", "", plainFailure(both(
			"Windows 上还不能把原生 Codex 接进来",
			"Native Codex cannot be attached on Windows yet",
		))
	}
	log, err := openLocalLog(c, "diagnostics.log")
	if err != nil {
		return "", "", err
	}
	defer log.Close()
	fmt.Fprintf(log, "\n[%s] codex --version\n", time.Now().Format(time.RFC3339))
	if path, err = locateCodex(c); err != nil {
		fmt.Fprintf(log, "%v\n", err)
		return "", "", err
	}
	fmt.Fprintf(log, "%s\n", path)
	probeCtx, cancel := context.WithTimeout(ctx, codexVersionTimeout)
	defer cancel()
	command := exec.CommandContext(probeCtx, path, "--version")
	command.Env = c.environment()
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, log
	runErr := command.Run()
	_, _ = log.Write(output.Bytes())
	if errors.Is(probeCtx.Err(), context.Canceled) {
		return "", "", context.Canceled
	}
	version = versionPattern.FindString(output.String())
	if runErr != nil || version == "" {
		fmt.Fprintf(log, "读不出版本: %v\n", runErr)
		return "", "", codexFailure(c, stateStartFailed, both(
			"无法读取 codex 的版本，请先确认 codex --version 可以正常运行",
			"Cannot read the codex version; make sure codex --version runs first",
		))
	}
	if order, _ := compareVersions(version, minimumCodexVersion); order < 0 {
		return "", "", codexFailure(c, stateVersionTooLow, both(
			"codex 的版本是 %s，低于要求的下限 %s，请升级后重试",
			"codex is %s, older than the minimum %s required here; upgrade it and retry",
		).with(version, minimumCodexVersion))
	}
	return path, version, nil
}

// 起 app-server 的命令行。参数以 codex 自己的 `app-server --help` 和上游源码为准：
// `--listen unix://PATH` 让它在这个套接字上监听（线上是套接字里的 WebSocket，和适配器的运行时一样）。
// 工作目录放在用户主目录：它不属于任何项目，不该捡到服务启动时所在目录里的项目配置。
func codexCommand(c configuration, path string) *exec.Cmd {
	process := exec.Command(path, "app-server", "--listen", hostplatform.ListenURL(c.socket()))
	process.Env = c.environment()
	if home, err := os.UserHomeDir(); err == nil {
		process.Dir = home
	}
	return process
}

// 设置里原生 codex 那一组的说明文字。
func codexSettingTexts() harnessTexts {
	group := both(
		"这台设备上你自己装的 Codex。打开后，它的会话和另外几个 harness 的列在一起，可以在这里新建会话、跑回合。它用的还是你自己的那份 Codex 数据（默认在 ~/.codex）：会话和登录状态与你在终端里用的是同一份。",
		"The Codex you installed on this device. Once enabled, its sessions are listed with those of the other harnesses, and you can create sessions and run turns here. It keeps using your own Codex data (~/.codex by default): the sessions and the sign-in are the ones you use in the terminal.",
	)
	return harnessTexts{
		group: &group,
		enabled: both(
			"打开后用这台设备上装的 codex 起一个 app-server，由这里的服务管着；关掉就停掉它，这台设备上不再提供 Codex。会话都在 Codex 自己的数据目录里，开关都不会动它们。要求 codex 的版本不低于 %s。",
			"Turning this on starts an app-server with the codex installed on this device, managed by this service; turning it off stops it, so this device no longer offers Codex. Sessions live in Codex's own data directory and are untouched either way. Requires codex %s or newer.",
		).with(minimumCodexVersion, minimumCodexVersion),
		cliPath: both(
			"这台设备上 codex 命令行的绝对路径。留空就在 PATH 里找。",
			"Absolute path of the codex command-line tool on this device. Leave empty to look it up on PATH.",
		),
		env: both(
			"只给这里起的这个 Codex 进程：代理、接口地址、密钥等。优先于启动服务的进程自己的环境，也优先于环境文件（状态目录下的 env）。想让它用另一份数据目录，在这里设 CODEX_HOME。",
			"Only for the Codex process started here: proxy, API endpoint, keys and so on. These take precedence over the environment of the process that started the service and over the environment file (env in the state directory). To point it at another data directory, set CODEX_HOME here.",
		),
	}
}

var codexCheckTitle = both("codex 命令行和版本", "codex CLI and version")

// 诊断里原生 codex 的那一项：能不能找到、版本够不够。
func codexChecks(ctx context.Context, c configuration) []diagnosticCheck {
	check := diagnosticCheck{ID: "runtime", Scope: harnessScope(c.harness), Status: "ok", Title: codexCheckTitle}
	if _, _, err := inspectCodex(ctx, c); err != nil {
		check.fail(err)
	}
	return []diagnosticCheck{check}
}
