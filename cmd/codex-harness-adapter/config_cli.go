package main

// config 子命令：配置 Litch 本身（产品手册里的 `litch config …` 落到这里）。这里只是一层薄壳：
// 取出 --json，按环境猜语言，认出是哪个会话发起的，把其余参数原样经本机设备服务的 litch/clientTool/invoke
// 交给连着的 Litch 桌面端（命名空间 litch_config、工具 run，参数形状见 packages/protocol/src/client-tools-config.mts）。
// 有哪些操作、怎么解析、帮助怎么写都在桌面端的执行器里，这里不认操作名，加操作不用改 Go。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

const (
	configNamespace = "litch_config"
	configTool      = "run"
)

// 按 LC_ALL、LANG 猜语言：zh 开头是 zh-CN，别的是 en；都没有（或是 C、POSIX）时猜不出，交给桌面端用界面的语言。
func configLanguage(env func(string) string) any {
	for _, name := range []string{"LC_ALL", "LANG"} {
		tag := strings.ToLower(strings.TrimSpace(env(name)))
		if cut := strings.IndexAny(tag, ".@"); cut >= 0 {
			tag = tag[:cut]
		}
		switch {
		case tag == "" || tag == "c" || tag == "posix":
			continue
		case strings.HasPrefix(tag, "zh"):
			return "zh-CN"
		}
		return "en"
	}
	return nil
}

// 取出 --json，其余原样（`--` 之后的一律不动）。
func configArguments(argv []string) (rest []string, asJSON bool) {
	rest = []string{}
	for index, arg := range argv {
		if arg == "--" {
			return append(rest, argv[index:]...), asJSON
		}
		if arg == "--json" {
			asJSON = true
			continue
		}
		rest = append(rest, arg)
	}
	return rest, asJSON
}

// 要 Litch 桌面端开着：没有连着的桌面端、设备服务不在时都这么说。按猜到的语言说，猜不出两种都给。
func configNeedsDesktop(lang any) string {
	zh := "这条命令要 Litch 桌面端开着，并且连着这台设备：配置是由桌面端执行的。请用户打开 Litch 后再试，不要反复重试。"
	en := "This command needs the Litch desktop app open and connected to this machine: the desktop carries out the configuration. Ask the user to open Litch and try again; do not keep retrying."
	switch lang {
	case "zh-CN":
		return zh
	case "en":
		return en
	}
	return zh + "\n" + en
}

func runConfig(ctx context.Context, argv []string) error {
	code := configMain(ctx, argv, machineIO{stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, env: os.Getenv})
	if code == 0 {
		return nil
	}
	return &exitError{code: code, err: errSilent}
}

func configMain(ctx context.Context, argv []string, io machineIO) int {
	rest, asJSON := configArguments(argv)
	lang := configLanguage(io.env)
	thread := firstNonEmpty(io.env(machineThreadVariables[0]), io.env(machineThreadVariables[1]),
		io.env(machineThreadVariables[2]), io.env(machineThreadVariables[3]))
	params := map[string]any{
		"namespace": configNamespace, "tool": configTool, "threadId": nil,
		"arguments": map[string]any{"argv": rest, "json": asJSON, "lang": lang},
	}
	if thread != "" {
		params["threadId"] = thread
	}
	rpc, err := dialDevice(ctx, machineSocket("", io.env))
	if err != nil {
		fmt.Fprintln(io.stderr, err)
		fmt.Fprintln(io.stderr, configNeedsDesktop(lang))
		return machineExitUnreachable
	}
	defer rpc.Close()
	raw, err := rpc.call(ctx, clientToolInvokeMethod, params)
	if err != nil {
		var rpcErr *deviceRPCError
		if errors.As(err, &rpcErr) {
			if rpcErr.Message == "Not initialized" || rpcErr.Code == -32601 {
				fmt.Fprintln(io.stderr, tr("这台机器上在跑的设备服务太旧，还不支持 config。请升级适配器、重启设备服务后再试。", "The device service running on this machine is too old for config. Upgrade the adapter and restart the device service, then try again."))
				return machineExitUnreachable
			}
			fmt.Fprintln(io.stderr, tr("设备服务回了错误：", "The device service answered with an error: ")+rpcErr.Message)
			if rpcErr.Code == -32602 {
				return machineExitUsage
			}
			return machineExitFailed
		}
		if ctx.Err() != nil {
			return 130
		}
		fmt.Fprintln(io.stderr, err)
		return machineExitFailed
	}
	var response machineResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		fmt.Fprintln(io.stderr, tr("桌面端的应答看不懂：", "The desktop's answer could not be read: ")+string(raw))
		return machineExitFailed
	}
	text := response.text()
	if !response.Success && failureKind.FindStringSubmatch(text) != nil && failureKind.FindStringSubmatch(text)[1] == "noExecutor" {
		// 设备进程的原话只有中文，还说的是命名空间：换成给人和模型都看得懂的那一句
		fmt.Fprintln(io.stdout, configNeedsDesktop(lang))
		return machineExitNoDesktop
	}
	if text != "" {
		fmt.Fprint(io.stdout, text)
		if !strings.HasSuffix(text, "\n") {
			fmt.Fprintln(io.stdout)
		}
	}
	if !response.Success {
		return failureExit(response)
	}
	return 0
}
