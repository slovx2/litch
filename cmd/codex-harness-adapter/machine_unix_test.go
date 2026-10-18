//go:build !windows

package main

// machine 子命令对着一个假的设备服务（unix 套接字上的 WebSocket，和真的聚合面一样）跑一遍：
// 发出去的请求对不对、结果怎么打、退出码、--json、--help 里的桌面端、连不上时怎么说。
// 对着真的设备进程跑的在 packages/device/test/client-tool-machine-cli.test.mts。

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fakeDevice struct {
	socket string
	mu     sync.Mutex
	seen   []map[string]any
	answer func(method string, params map[string]any) (any, *deviceRPCError)
	closed chan struct{}
}

func startFakeDevice(t *testing.T) *fakeDevice {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "lm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	device := &fakeDevice{socket: filepath.Join(dir, "device.sock"), closed: make(chan struct{}, 4)}
	listener, err := net.Listen("unix", device.socket)
	if err != nil {
		t.Fatal(err)
	}
	upgrader := websocket.Upgrader{}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { device.closed <- struct{}{} }()
		defer conn.Close()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame map[string]any
			_ = json.Unmarshal(data, &frame)
			device.mu.Lock()
			device.seen = append(device.seen, frame)
			answer := device.answer
			device.mu.Unlock()
			params, _ := frame["params"].(map[string]any)
			// 先来一条不相干的通知，命令行要跳过它
			_ = conn.WriteJSON(map[string]any{"method": "noise", "params": map[string]any{}})
			result, failure := answer(frame["method"].(string), params)
			if result == nil && failure == nil {
				continue // 故意不答
			}
			reply := map[string]any{"id": frame["id"]}
			if failure != nil {
				reply["error"] = failure
			} else {
				reply["result"] = result
			}
			_ = conn.WriteJSON(reply)
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return device
}

func textResult(success bool, text string) map[string]any {
	return map[string]any{"success": success, "contentItems": []any{map[string]any{"type": "inputText", "text": text}}}
}

func runAgainst(t *testing.T, device *fakeDevice, stdin string, argv ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	env := map[string]string{deviceSocketEnvironment: device.socket, "LITCH_THREAD_ID": "thread-9"}
	code := machineMain(context.Background(), argv, machineIO{
		stdin: strings.NewReader(stdin), stdout: &stdout, stderr: &stderr, env: envOf(env),
	})
	return code, stdout.String(), stderr.String()
}

func TestMachineAgainstFakeDevice(t *testing.T) {
	device := startFakeDevice(t)
	device.answer = func(method string, params map[string]any) (any, *deviceRPCError) {
		if method != clientToolInvokeMethod {
			return nil, &deviceRPCError{Code: -32601, Message: "no"}
		}
		switch params["tool"] {
		case "exec":
			return textResult(true, "status: exited\nexit_code: 7\nduration_ms: 3\nseq: 4\noutput:\nboom\n"), nil
		case "read_file":
			return textResult(true, "file text"), nil
		case "list_dir":
			return textResult(false, "[litch:declined] 用户拒绝了：别看"), nil
		case "machines":
			return textResult(false, "[litch:ambiguous] 连着 a、b"), nil
		case "copy":
			// 这之前的设备服务：没握手就调，它说没握手
			return nil, &deviceRPCError{Code: -32600, Message: "Not initialized"}
		}
		return nil, &deviceRPCError{Code: -32602, Message: "参数不对"}
	}
	code, stdout, stderr := runAgainst(t, device, "", "exec", "--cwd", "/tmp", "false")
	if code != 7 || stdout != "boom\n" || stderr != "" {
		t.Fatalf("exec: %d %q %q", code, stdout, stderr)
	}
	device.mu.Lock()
	sent := device.seen[0]
	device.mu.Unlock()
	params := sent["params"].(map[string]any)
	if sent["method"] != clientToolInvokeMethod || params["namespace"] != "litch_machine" || params["tool"] != "exec" ||
		params["threadId"] != "thread-9" || params["desktop"] != nil {
		t.Fatalf("发出去的请求不对：%v", sent)
	}
	if args := params["arguments"].(map[string]any); args["command"] != "false" || args["cwd"] != "/tmp" {
		t.Fatalf("参数不对：%v", args)
	}
	code, stdout, _ = runAgainst(t, device, "", "read", "/etc/hosts", "--desktop", "mac")
	if code != 0 || stdout != "file text\n" {
		t.Fatalf("read: %d %q", code, stdout)
	}
	device.mu.Lock()
	if device.seen[1]["params"].(map[string]any)["desktop"] != "mac" {
		t.Fatalf("--desktop 没带上：%v", device.seen[1])
	}
	device.mu.Unlock()
	code, stdout, stderr = runAgainst(t, device, "", "ls", "/")
	if code != machineExitDeclined || stdout != "" || !strings.Contains(stderr, "别看") {
		t.Fatalf("ls: %d %q %q", code, stdout, stderr)
	}
	code, _, stderr = runAgainst(t, device, "", "machines")
	if code != machineExitAmbiguous || !strings.Contains(stderr, "[litch:ambiguous]") {
		t.Fatalf("machines: %d %q", code, stderr)
	}
	code, stdout, _ = runAgainst(t, device, "", "exec", "--json", "false")
	var whole map[string]any
	if code != 7 || json.Unmarshal([]byte(stdout), &whole) != nil || whole["success"] != true {
		t.Fatalf("--json: %d %q", code, stdout)
	}
	code, _, stderr = runAgainst(t, device, "", "cp", "session:/a", "desktop:/b")
	if code != machineExitUnreachable || !strings.Contains(stderr, "太旧") {
		t.Fatalf("旧服务：%d %q", code, stderr)
	}
	code, _, stderr = runAgainst(t, device, "", "write", "/x", "--content", "y")
	if code != machineExitUsage || !strings.Contains(stderr, "参数不对") {
		t.Fatalf("write: %d %q", code, stderr)
	}
}

func TestMachineHelpNamesDesktops(t *testing.T) {
	device := startFakeDevice(t)
	device.answer = func(method string, _ map[string]any) (any, *deviceRPCError) {
		return map[string]any{"desktops": []any{
			map[string]any{"hostname": "songs-mbp", "name": "Song 的 MacBook", "namespaces": []any{"litch_machine"}},
			map[string]any{"hostname": "other", "namespaces": []any{"litch_browser"}},
		}}, nil
	}
	code, stdout, _ := runAgainst(t, device, "", "--help")
	if code != 0 || !strings.Contains(stdout, `"Song 的 MacBook" (songs-mbp)`) || strings.Contains(stdout, "other") {
		t.Fatalf("help: %d %q", code, stdout)
	}
	host, _ := os.Hostname()
	if first := strings.SplitN(stdout, "\n", 3)[1]; !strings.Contains(first, host) || !strings.Contains(first, "desktop") {
		t.Fatalf("第一段要写这台机器和桌面端：%q", first)
	}
}

func TestMachineUnreachableAndCancel(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := machineMain(context.Background(), []string{"machines", "--home", t.TempDir()}, machineIO{
		stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr, env: envOf(nil),
	})
	if code != machineExitUnreachable || !strings.Contains(stderr.String(), "device") {
		t.Fatalf("连不上：%d %q", code, stderr.String())
	}
	// 帮助在连不上时照样给，说明不知道是哪台
	stdout.Reset()
	if code := machineMain(context.Background(), []string{"--help", "--home", t.TempDir()}, machineIO{
		stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr, env: envOf(nil),
	}); code != 0 || !strings.Contains(stdout.String(), "litch-machine machines") {
		t.Fatalf("help: %d %q", code, stdout.String())
	}
	// 一直不答：取消时关掉连接（设备进程据此撤回调用），退出码 130
	device := startFakeDevice(t)
	device.answer = func(string, map[string]any) (any, *deviceRPCError) { return nil, nil }
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	stderr.Reset()
	code = machineMain(ctx, []string{"exec", "sleep 100"}, machineIO{
		stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr,
		env: envOf(map[string]string{deviceSocketEnvironment: device.socket}),
	})
	if code != 130 {
		t.Fatalf("取消：%d %q", code, stderr.String())
	}
	select {
	case <-device.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("取消之后连接没关")
	}
}
