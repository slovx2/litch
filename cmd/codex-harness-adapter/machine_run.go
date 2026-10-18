package main

// machine 子命令：转交、把结果打出来、说明。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// 适配器交给运行时的变量：设备服务的套接字在哪。harness 跑的命令继承得到，machine 子命令靠它找到非默认状态目录下的服务
const deviceSocketEnvironment = "LITCH_DEVICE_SOCKET"

type machineIO struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	env            func(string) string
}

// 桌面端执行的结果（ClientToolCallResponse）
type machineResponse struct {
	Success      bool `json:"success"`
	ContentItems []struct {
		Type     string `json:"type"`
		Text     string `json:"text,omitempty"`
		ImageURL string `json:"imageUrl,omitempty"`
	} `json:"contentItems"`
}

func runMachine(ctx context.Context, argv []string) error {
	code := machineMain(ctx, argv, machineIO{stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, env: os.Getenv})
	if code == 0 {
		return nil
	}
	// 话已经打过了，这里只带退出码（main 打印错误时跳过空的）
	return &exitError{code: code, err: errSilent}
}

var errSilent = errors.New("")

func machineMain(ctx context.Context, argv []string, io machineIO) int {
	command, err := parseMachineArgs(argv, io.env, io.stdin)
	if err != nil {
		fmt.Fprintln(io.stderr, err)
		var usage *machineUsageError
		if errors.As(err, &usage) {
			fmt.Fprintln(io.stderr, tr("用法见 litch-machine --help", "See litch-machine --help"))
			return machineExitUsage
		}
		return machineExitFailed
	}
	if command.help {
		socket := command.socket
		if socket == "" {
			socket = machineSocket("", io.env)
		}
		desktops, err := fetchDesktops(ctx, socket, 2*time.Second)
		fmt.Fprintln(io.stdout, machineHelp(desktops, err))
		return 0
	}
	params := map[string]any{"namespace": machineNamespace, "tool": command.tool, "arguments": command.args, "threadId": nil}
	if command.thread != "" {
		params["threadId"] = command.thread
	}
	if command.desktop != "" {
		params["desktop"] = command.desktop
	}
	rpc, err := dialDevice(ctx, command.socket)
	if err != nil {
		fmt.Fprintln(io.stderr, err)
		fmt.Fprintln(io.stderr, unreachableHint(err))
		return machineExitUnreachable
	}
	defer rpc.Close()
	raw, err := rpc.call(ctx, clientToolInvokeMethod, params)
	if err != nil {
		var rpcErr *deviceRPCError
		if errors.As(err, &rpcErr) {
			// 这之前的设备服务不认识这个方法：不握手就调，它回“没握手”；握手了它回“方法不存在”
			if rpcErr.Message == "Not initialized" || rpcErr.Code == -32601 {
				fmt.Fprintln(io.stderr, tr("这台机器上在跑的设备服务太旧，还不支持 machine。请升级适配器、重启设备服务后再试。", "The device service running on this machine is too old for machine. Upgrade the adapter and restart the device service, then try again."))
				return machineExitUnreachable
			}
			fmt.Fprintln(io.stderr, tr("设备服务回了错误：", "The device service answered with an error: ")+rpcErr.Message)
			if rpcErr.Code == -32602 {
				return machineExitUsage
			}
			return machineExitFailed
		}
		fmt.Fprintln(io.stderr, err)
		if ctx.Err() != nil {
			return 130
		}
		return machineExitFailed
	}
	var response machineResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		fmt.Fprintln(io.stderr, tr("桌面端的应答看不懂：", "The desktop's answer could not be read: ")+string(raw))
		return machineExitFailed
	}
	if command.json {
		var pretty any
		_ = json.Unmarshal(raw, &pretty)
		encoded, _ := json.MarshalIndent(pretty, "", "  ")
		fmt.Fprintln(io.stdout, string(encoded))
		if !response.Success {
			return failureExit(response)
		}
		if command.tool == "exec" {
			_, _, code := execOutcome(response.text())
			return code
		}
		return 0
	}
	return renderMachine(command, response, io)
}

// 文字项连起来
func (r machineResponse) text() string {
	parts := []string{}
	for _, item := range r.ContentItems {
		if item.Type == "inputText" {
			parts = append(parts, item.Text)
		}
	}
	return strings.Join(parts, "\n")
}

var failureKind = regexp.MustCompile(`^\[litch:([A-Za-z]+)\] `)

// 失败答复第一行的 [litch:<kind>] 定退出码
func failureExit(response machineResponse) int {
	match := failureKind.FindStringSubmatch(response.text())
	if match == nil {
		return machineExitFailed
	}
	switch match[1] {
	case "invalid":
		return machineExitUsage
	case "permission":
		return machineExitPermission
	case "noExecutor":
		return machineExitNoDesktop
	case "ambiguous":
		return machineExitAmbiguous
	case "declined":
		return machineExitDeclined
	case "disabled":
		return machineExitDisabled
	case "blocked":
		return machineExitBlocked
	}
	return machineExitFailed
}

func renderMachine(command machineCommand, response machineResponse, io machineIO) int {
	text := response.text()
	if !response.Success {
		fmt.Fprintln(io.stderr, text)
		return failureExit(response)
	}
	for _, item := range response.ContentItems {
		if item.Type == "inputImage" {
			fmt.Fprintf(io.stderr, tr("［一张图片，%d 字节的 data 地址，这里不打出来；要原文用 --json，要文件用 cp］\n", "[an image, a %d-byte data URL, not printed; use --json for it, or cp for the file]\n"), len(item.ImageURL))
		}
	}
	if command.tool != "exec" {
		if text != "" {
			fmt.Fprintln(io.stdout, strings.TrimRight(text, "\n"))
		}
		return 0
	}
	output, notes, code := execOutcome(text)
	if output != "" {
		fmt.Fprint(io.stdout, output)
		if !strings.HasSuffix(output, "\n") {
			fmt.Fprintln(io.stdout)
		}
	}
	for _, note := range notes {
		fmt.Fprintln(io.stderr, note)
	}
	return code
}

var (
	outputLabel = regexp.MustCompile(`^output( so far)?:$`)
	exitInText  = regexp.MustCompile(`exit code (-?\d+)`)
)

// execOutcome 从桌面端给模型的那段文字里拆出命令的输出、要另外说的几行和退出码。
// 那段文字的样子归执行器（packages/core/src/device/machine/processes.mts）：开头几行 `键: 值`
// （exit_code、status、process_id、duration_ms、seq），然后一行 `output:`（还在跑时是 `output so far:`），后面是输出。
// 认不出这个样子时整段当输出、退出码 0。
func execOutcome(text string) (output string, notes []string, code int) {
	lines := strings.Split(text, "\n")
	header := map[string]string{}
	at := -1
	for index, line := range lines {
		if outputLabel.MatchString(line) {
			at = index
			break
		}
		if key, value, ok := strings.Cut(line, ": "); ok {
			header[key] = value
		}
	}
	if at < 0 {
		return text, nil, 0
	}
	output = strings.Join(lines[at+1:], "\n")
	status := header["status"]
	if value, ok := header["exit_code"]; ok {
		if number, err := strconv.Atoi(value); err == nil {
			code = number
		}
		return output, nil, normalizeExit(code)
	}
	if id := header["process_id"]; id != "" && strings.HasPrefix(status, "still running") {
		return output, []string{"process_id: " + id, "status: " + status}, machineExitRunning
	}
	notes = []string{"status: " + status}
	switch {
	case strings.HasPrefix(status, "timed out"):
		code = 124
		if match := exitInText.FindStringSubmatch(status); match != nil {
			code, _ = strconv.Atoi(match[1])
		}
	case status == "killed":
		code = 137
	default:
		code = machineExitFailed
	}
	return output, notes, normalizeExit(code)
}

// 退出码只能是 0 到 255
func normalizeExit(code int) int {
	if code < 0 || code > 255 {
		return machineExitFailed
	}
	return code
}

func machineHelp(desktops []machineDesktop, problem error) string {
	host, _ := os.Hostname()
	system := fmt.Sprintf("%s %s", map[string]string{"darwin": "macOS", "linux": "Linux", "windows": "Windows"}[runtime.GOOS], runtime.GOARCH)
	names := []string{}
	for _, desktop := range desktops {
		for _, namespace := range desktop.Namespaces {
			if namespace == machineNamespace {
				names = append(names, desktop.label())
				break
			}
		}
	}
	var connected string
	switch {
	case problem != nil:
		connected = tr("现在连不上这台机器上的设备服务，不知道是哪台", "the device service on this machine cannot be reached right now, so it is not known which one")
	case len(names) == 0:
		connected = tr("现在没有哪台连着这台机器", "none is connected to this machine right now")
	default:
		connected = tr("现在连着的是 ", "connected now: ") + strings.Join(names, tr("、", ", "))
	}
	return fmt.Sprintf(tr(machineHelpZH, machineHelpEN), host, system, connected, machineShortName)
}

// 连不上时下一步怎么办。EPERM 是沙箱拦的：codex 的沙箱（macOS 的 seatbelt、Linux 的 seccomp）默认不许连 unix 套接字，
// 实测只读和工作区可写两档都是这样。codex 认“operation not permitted”这几个字为沙箱拒绝，
// 原话照样打在上一行；这里明说要以不受沙箱限制的方式重跑，模型才会去申请提权
func unreachableHint(err error) string {
	switch {
	case errors.Is(err, syscall.EPERM):
		return tr("连接被沙箱拦下了：命令所在的沙箱不许连本机的 unix 套接字。请以不受沙箱限制的方式（申请提权）重新运行这条命令。",
			"The connection was blocked by a sandbox that does not allow local unix sockets. Re-run this command outside the sandbox (request escalated permissions).")
	case errors.Is(err, syscall.EACCES):
		return tr("没有权限连这个设备服务：它属于别的用户，或者套接字的权限不对。",
			"No permission to connect to this device service: it belongs to another user, or the socket's permissions are wrong.")
	}
	return tr("这台机器上的适配器设备服务没在运行，或者不是这个状态目录（--home）。Litch 桌面端连上这台设备时会把它拉起来。",
		"The adapter's device service is not running on this machine, or uses another state directory (--home). Litch starts it when the desktop connects to this machine.")
}
