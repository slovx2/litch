package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

type runtimeDetails struct {
	Engine          string `json:"engine"`
	ProtocolVersion string `json:"protocolVersion"`
	NodeVersion     string `json:"nodeVersion"`
}

// 用户环境只要求 Node 24 及以上稳定版。
const minimumNodeMajor = 24

// 原始诊断只保存在本入口的私有日志中，不把 JSON、警告和堆栈混入用户输出。
func openLocalLog(c configuration, name string) (*os.File, error) {
	return openPrivateLog(c.directory(), name)
}

// 设备进程和后台服务的日志不属于任何一个入口，按目录打开。
func openPrivateLog(directory, name string) (*os.File, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf(tr("无法创建状态目录，请检查目录权限: %w", "cannot create the state directory; check its permissions: %w"), err)
	}
	if err := hostplatform.Protect(directory); err != nil {
		return nil, fmt.Errorf(tr("无法保护状态目录，请检查目录权限: %w", "cannot restrict access to the state directory; check its permissions: %w"), err)
	}
	path := filepath.Join(directory, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf(tr("无法写入日志，请检查目录权限: %w", "cannot write the log; check the directory permissions: %w"), err)
	}
	if err := hostplatform.Protect(path); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf(tr("无法保护日志文件: %w", "cannot restrict access to the log file: %w"), err)
	}
	return file, nil
}

// 一个 harness 没能提供服务的原因，分了类。命令行照 Error 打印；报给客户端时用 kind 和 text。
type harnessFailure struct {
	kind    string    // notInstalled、versionTooLow、startFailed、stopped
	text    bilingual // 原因和该怎么办，不带日志的位置
	logPath string
	err     error
}

func (f *harnessFailure) Error() string { return f.err.Error() }
func (f *harnessFailure) Unwrap() error { return f.err }

func diagnosticFailure(c configuration, kind string, text bilingual) error {
	logPath := filepath.Join(c.directory(), "diagnostics.log")
	return &harnessFailure{kind: kind, text: text, logPath: logPath,
		err: fmt.Errorf(tr("%s；详细日志：%s", "%s; detailed log: %s"), text, logPath)}
}

// 找不到一个 harness 的命令行时怎么说。这句话命令行会打印，也会原样显示在客户端里，所以：
// 只提这个 harness 自己的那个环境变量，并说明设备的设置里也能填路径（界面上那一项叫“命令行路径”，括号里是它的键）。
// 路径已经给了、只是给得不对的，说哪一处该改：设置里填的盖过环境变量。
// 原生 codex 的路径只在设置里填，没有环境变量这条路。
func cliMissing(c configuration) bilingual {
	id := c.harness
	name, variable, key := harnessNames[id], harnessCLIVariable[id], cliPathKey(id)
	switch {
	case c.settings.text(key) != "":
		return both(
			"设置里给 %s 填的“命令行路径”（%s）不是一个可执行的文件。改成它的命令行的绝对路径，或者清空这一项改在 PATH 里找",
			"The \"CLI path\" set for %s in settings (%s) is not an executable file. Set it to the absolute path of its command-line tool, or clear it to look it up on PATH",
		).with(name, key)
	case specOf(id).needsCLI && c.environmentValue(variable) == "":
		// 没有预设命令：不是“没装”，是还没说要接哪个 agent
		return both(
			"%[1]s 没有预设的命令，要告诉它接哪个 ACP agent：在这台设备的设置里填“命令行路径”（%[2]s），或者用环境变量 %[3]s 指定命令；参数写在环境变量 %[4]s 里",
			"%[1]s has no preset command; tell it which ACP agent to run: fill in \"CLI path\" (%[2]s) in this device's settings, or set the %[3]s environment variable; put the arguments in the %[4]s environment variable",
		).with(name, key, variable, strings.TrimSuffix(variable, "_CLI")+"_ARGS")
	case variable == "":
		return both(
			"没有找到 %s 的命令行。装好之后重新启动它；也可以在这台设备的设置里填“命令行路径”（%s）",
			"The %s command-line tool was not found. Install it and start this harness again; you can also fill in \"CLI path\" (%s) in this device's settings",
		).with(name, key)
	case c.environmentValue(variable) != "":
		return both(
			"环境变量 %[3]s 指的不是 %[1]s 的可执行的命令行。把它改对，或者去掉它改在 PATH 里找；也可以在这台设备的设置里填“命令行路径”（%[2]s）",
			"The %[3]s environment variable does not point to an executable %[1]s command-line tool. Correct it, or remove it to look it up on PATH; you can also fill in \"CLI path\" (%[2]s) in this device's settings",
		).with(name, key, variable)
	}
	return both(
		"没有找到 %s 的命令行。装好之后重新启动它（刚装的先重开终端，让 PATH 生效）；也可以在这台设备的设置里填“命令行路径”（%s），或者用环境变量 %s 指定它的路径",
		"The %s command-line tool was not found. Install it and start this harness again (reopen the terminal first if you just installed it, so that PATH is up to date); you can also fill in \"CLI path\" (%s) in this device's settings, or point to it with the %s environment variable",
	).with(name, key, variable)
}

func runDiagnostic(ctx context.Context, c configuration, flag string) ([]byte, error) {
	log, err := openLocalLog(c, "diagnostics.log")
	if err != nil {
		return nil, err
	}
	defer log.Close()
	fmt.Fprintf(log, "\n[%s] %s\n", time.Now().Format(time.RFC3339), flag)
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, c.node, c.adapter(), flag)
	hostplatform.Quiet(command)
	command.Env = c.environment()
	var output, stderr bytes.Buffer
	command.Stdout = io.MultiWriter(&output, log)
	command.Stderr = io.MultiWriter(&stderr, log)
	err = command.Run()
	if err == nil {
		return output.Bytes(), nil
	}
	fmt.Fprintf(log, tr("\n检查失败: %v\n", "\nCheck failed: %v\n"), err)
	if errors.Is(probeCtx.Err(), context.Canceled) {
		return nil, context.Canceled
	}
	kind := "startFailed"
	message := both("环境检查失败，请运行 npm run setup 重新安装和构建", "The environment check failed; run npm run setup to reinstall and rebuild")
	// 下面按引擎进程写到标准错误的原文识别原因。那些文字只有中文，不随命令行的输出语言变。
	switch {
	case errors.Is(probeCtx.Err(), context.DeadlineExceeded):
		message = both("环境检查超时，请确认本机引擎命令可以正常运行后重试", "The environment check timed out; make sure the engine's command runs on this machine, then retry")
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		message = both("无法启动 Node.js，请确认已安装并加入 PATH，或使用 --node 指定路径", "Cannot start Node.js; make sure it is installed and on PATH, or point to it with --node")
	case flag == "--pty-self-check":
		// 伪终端桥是命令行自带的（pty-bridge 子命令），macOS 和 Linux 上不靠系统里别的东西。
		message = both("终端检查失败：带终端的命令没有起来。Windows 上请确认装有 Git for Windows；其余情况原因在日志里", "The terminal check failed: a command with a terminal did not start. On Windows, make sure Git for Windows is installed; otherwise the cause is in the log")
	case strings.Contains(stderr.String(), "CLI 不可执行或未找到"):
		kind = "notInstalled"
		message = cliMissing(c)
	case strings.Contains(stderr.String(), "定位 Pi 的 npm 包"), strings.Contains(stderr.String(), "用户安装的 Pi 缺少依赖"):
		message = both("无法加载用户安装的 Pi：Pi 入口需要通过 npm 完整安装的 Pi（独立二进制不可用），请用 npm 安装后重试，或通过 PI_CLI 指定 npm 包内的 CLI", "Cannot load your Pi installation: the Pi entry needs a full npm install of Pi (the standalone binary will not work). Install it with npm and retry, or point PI_CLI at the CLI inside the npm package")
	case strings.Contains(stderr.String(), "与适配器不兼容"):
		message = both("用户安装的 Pi 与当前适配器不兼容，请升级适配器，或通过 PI_CLI 指定受支持的 Pi 版本", "Your Pi installation is not compatible with this adapter; upgrade the adapter, or point PI_CLI at a supported Pi version")
	case strings.Contains(stderr.String(), "dsh CLI 版本不符"):
		kind = "versionTooLow"
		message = both("DSH 版本低于适配器要求的下限，请升级 dsh 后重试", "DSH is older than the minimum this adapter requires; upgrade dsh and retry")
	case strings.Contains(stderr.String(), "无法读取宿主 dsh CLI 版本"):
		message = both("无法读取 DSH 版本，请先确认 dsh --version 可以正常运行", "Cannot read the DSH version; make sure dsh --version runs first")
	case strings.Contains(stderr.String(), "OpenCode CLI 版本不符"):
		kind = "versionTooLow"
		message = both("OpenCode 版本低于适配器要求的下限，请升级 opencode 后重试", "OpenCode is older than the minimum this adapter requires; upgrade opencode and retry")
	case strings.Contains(stderr.String(), "无法读取宿主 OpenCode CLI 版本"):
		message = both("无法读取 OpenCode 版本，请先确认 opencode --version 可以正常运行", "Cannot read the OpenCode version; make sure opencode --version runs first")
	case strings.Contains(stderr.String(), "ACP 协议版本不符"):
		// 适配器说的是 ACP 协议第 1 版；对面回的不是这一版，多半是 agent 太旧
		kind = "versionTooLow"
		message = both(
			"%s 说的 ACP 协议版本和适配器不一致，请升级它后重试",
			"%s speaks a different version of the ACP protocol from this adapter; upgrade it and retry",
		).with(harnessNames[c.harness])
	case strings.Contains(stderr.String(), "Claude CLI 版本不符"), strings.Contains(stderr.String(), "需要用户安装的 Pi CLI"):
		kind = "versionTooLow"
		message = both("引擎 CLI 版本检查未通过，请安装适配器说明（ADAPTER.md）要求的最低稳定版本或更高版本", "The engine CLI failed the version check; install the minimum stable version listed in the adapter guide (ADAPTER.en.md) or newer")
	case strings.Contains(stderr.String(), "无法读取宿主 Claude CLI 版本"):
		message = both("无法读取 Claude Code 版本，请先确认 claude --version 可以正常运行", "Cannot read the Claude Code version; make sure claude --version runs first")
	case strings.Contains(stderr.String(), "需要 Node >="):
		message = both("Node.js 版本过低，请安装适配器说明（ADAPTER.md）要求的最低稳定版本或更高版本", "Node.js is too old; install the minimum stable version listed in the adapter guide (ADAPTER.en.md) or newer")
	case strings.Contains(stderr.String(), "沙箱依赖不可用"):
		message = both("沙箱依赖不可用，请检查 Linux 的 bubblewrap 或 macOS 的 sandbox-exec", "The sandbox dependencies are unavailable; check bubblewrap on Linux, or sandbox-exec on macOS")
	}
	return nil, diagnosticFailure(c, kind, message)
}

func inspectRuntime(ctx context.Context, c configuration) (runtimeDetails, error) {
	output, err := runDiagnostic(ctx, c, "--runtime-info")
	var info runtimeDetails
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal(output, &info); err != nil || info.Engine != c.harness || info.ProtocolVersion == "" {
		return info, diagnosticFailure(c, "startFailed", both("环境检查结果无效，请运行 npm run setup 重新构建", "The environment check returned an invalid result; run npm run setup to rebuild"))
	}
	if major, err := strconv.Atoi(strings.SplitN(info.NodeVersion, ".", 2)[0]); err != nil || major < minimumNodeMajor {
		return info, diagnosticFailure(c, "startFailed", both("Node.js 版本过低，需要 Node %d 或更高版本，可用 --node 指定路径", "Node.js is too old: Node %d or newer is required; point to it with --node").with(minimumNodeMajor))
	}
	return info, nil
}

// 一项检查的结果。命令行的 doctor 和经协议跑的诊断用的是同一套检查，只是一个打印、一个原样交给客户端。
type diagnosticCheck struct {
	ID      string       `json:"id"`
	Scope   settingScope `json:"scope"`
	Status  string       `json:"status"` // ok、failed、skipped
	Title   bilingual    `json:"title"`
	Detail  *bilingual   `json:"detail"`
	LogPath *string      `json:"logPath"`
	// 命令行打印用的原样错误。
	err error
}

func (check *diagnosticCheck) fail(err error) {
	check.Status, check.err = "failed", err
	var failure *harnessFailure
	if errors.As(err, &failure) {
		check.Detail = &failure.text
		if failure.logPath != "" {
			check.LogPath = &failure.logPath
		}
		return
	}
	text := verbatim(err.Error())
	check.Detail = &text
}

// 一个 harness 的检查，按次序做；前一项没过，后面的就不做了，记成跳过。
func harnessChecks(ctx context.Context, c configuration) []diagnosticCheck {
	if c.native() {
		return codexChecks(ctx, c)
	}
	checks := []diagnosticCheck{}
	failed := false
	add := func(id string, title bilingual, run func() error) {
		check := diagnosticCheck{ID: id, Scope: harnessScope(c.harness), Title: title, Status: "ok"}
		if failed {
			check.Status = "skipped"
		} else if err := run(); err != nil {
			failed = true
			check.fail(err)
		}
		checks = append(checks, check)
	}
	if runtime.GOOS == "windows" {
		add("shell", both("Git for Windows 的 bash", "bash from Git for Windows"), func() error {
			if _, err := exec.LookPath(hostplatform.DefaultShell()); err != nil {
				return fmt.Errorf(tr("Windows SSH 需要 Git for Windows 的 bash.exe: %w", "SSH on Windows needs bash.exe from Git for Windows: %w"), err)
			}
			return nil
		})
	}
	add("runtime", both("引擎的命令行和运行环境", "Engine CLI and runtime environment"), func() error {
		_, err := inspectRuntime(ctx, c)
		return err
	})
	add("terminal", both("终端", "Terminal"), func() error {
		_, err := runDiagnostic(ctx, c, "--pty-self-check")
		return err
	})
	return checks
}
