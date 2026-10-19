//go:build !windows

package main

// config 子命令对着假的设备服务：发出去的是 litch_config.run，参数原样、--json 取出、语言和会话号照环境；
// 结果的文字原样打到标准输出，失败时退出码非零；没有桌面端、连不上设备服务时说清楚要 Litch 桌面端开着。

import (
	"bytes"
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func runConfigAgainst(t *testing.T, socket string, env map[string]string, argv ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	values := map[string]string{deviceSocketEnvironment: socket}
	for name, value := range env {
		values[name] = value
	}
	code := configMain(context.Background(), argv, machineIO{stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr, env: envOf(values)})
	return code, stdout.String(), stderr.String()
}

func TestConfigAgainstFakeDevice(t *testing.T) {
	device := startFakeDevice(t)
	answer := textResult(true, "devices:\n  local  connected")
	device.answer = func(method string, params map[string]any) (any, *deviceRPCError) {
		if method != clientToolInvokeMethod {
			return nil, &deviceRPCError{Code: -32601, Message: "no"}
		}
		return answer, nil
	}
	code, stdout, stderr := runConfigAgainst(t, device.socket, map[string]string{"LC_ALL": "zh_CN.UTF-8", "LANG": "en_US.UTF-8", "CODEX_THREAD_ID": "thread-7"},
		"devices", "list", "--json", "--", "--json")
	if code != 0 || stdout != "devices:\n  local  connected\n" || stderr != "" {
		t.Fatalf("成功时原样打出: %d %q %q", code, stdout, stderr)
	}
	device.mu.Lock()
	frame := device.seen[len(device.seen)-1]
	device.mu.Unlock()
	params := frame["params"].(map[string]any)
	if frame["method"] != clientToolInvokeMethod || params["namespace"] != "litch_config" || params["tool"] != "run" || params["threadId"] != "thread-7" {
		t.Fatalf("请求不对: %+v", frame)
	}
	arguments := params["arguments"].(map[string]any)
	want := map[string]any{"argv": []any{"devices", "list", "--", "--json"}, "json": true, "lang": "zh-CN"}
	if !reflect.DeepEqual(arguments, want) {
		t.Fatalf("参数: %+v", arguments)
	}

	// 失败：文字照样打到标准输出，退出码按 [litch:<原因>] 定
	answer = textResult(false, "[litch:invalid] 没有这个操作：devices frobnicate")
	code, stdout, _ = runConfigAgainst(t, device.socket, map[string]string{"LANG": "en_US.UTF-8"}, "devices", "frobnicate")
	if code != machineExitUsage || !strings.Contains(stdout, "devices frobnicate") {
		t.Fatalf("失败时: %d %q", code, stdout)
	}
	device.mu.Lock()
	arguments = device.seen[len(device.seen)-1]["params"].(map[string]any)["arguments"].(map[string]any)
	threadID := device.seen[len(device.seen)-1]["params"].(map[string]any)["threadId"]
	device.mu.Unlock()
	if arguments["lang"] != "en" || arguments["json"] != false || threadID != nil {
		t.Fatalf("语言按 LANG，没有会话号时是 null: %+v %v", arguments, threadID)
	}

	// 没有桌面端连着
	answer = textResult(false, "[litch:noExecutor] 这台设备现在没有连着能执行 litch_config 的 Litch 桌面端")
	code, stdout, _ = runConfigAgainst(t, device.socket, map[string]string{"LANG": "C"})
	if code != machineExitNoDesktop || !strings.Contains(stdout, "Litch 桌面端开着") || !strings.Contains(stdout, "Litch desktop app open") {
		t.Fatalf("没有桌面端时（语言猜不出给两种）: %d %q", code, stdout)
	}
	device.mu.Lock()
	arguments = device.seen[len(device.seen)-1]["params"].(map[string]any)["arguments"].(map[string]any)
	device.mu.Unlock()
	if arguments["lang"] != nil || !reflect.DeepEqual(arguments["argv"], []any{}) {
		t.Fatalf("没有参数也原样交过去，语言猜不出是 null: %+v", arguments)
	}

	// 设备服务太旧：不认识 invoke
	device.answer = func(string, map[string]any) (any, *deviceRPCError) {
		return nil, &deviceRPCError{Code: -32600, Message: "Not initialized"}
	}
	if code, _, stderr := runConfigAgainst(t, device.socket, nil, "status"); code != machineExitUnreachable || !strings.Contains(stderr, "config") {
		t.Fatalf("设备服务太旧: %d %q", code, stderr)
	}
}

func TestConfigUnreachable(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "device.sock")
	code, _, stderr := runConfigAgainst(t, socket, map[string]string{"LANG": "en_US"}, "status")
	if code != machineExitUnreachable || !strings.Contains(stderr, "Litch desktop app open") {
		t.Fatalf("连不上设备服务: %d %q", code, stderr)
	}
}

func TestConfigLanguage(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want any
	}{
		{map[string]string{"LC_ALL": "zh_TW.UTF-8"}, "zh-CN"},
		{map[string]string{"LANG": "zh_CN.UTF-8"}, "zh-CN"},
		{map[string]string{"LC_ALL": "en_GB", "LANG": "zh_CN"}, "en"},
		{map[string]string{"LANG": "ja_JP.UTF-8"}, "en"},
		{map[string]string{"LC_ALL": "C", "LANG": "zh_CN"}, "zh-CN"},
		{map[string]string{"LANG": "POSIX"}, nil},
		{map[string]string{}, nil},
	}
	for _, item := range cases {
		if got := configLanguage(envOf(item.env)); got != item.want {
			t.Fatalf("%v 猜成 %v，应为 %v", item.env, got, item.want)
		}
	}
}
