//go:build !windows

package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestConfigExternalStdinUsesPrivateDeviceConnection(t *testing.T) {
	device := startFakeDevice(t)
	const secret = "fixture-token-never-stdout"
	for _, fail := range []bool{false, true} {
		device.mu.Lock()
		device.answer = func(method string, params map[string]any) (any, *deviceRPCError) {
			credential := map[string]any{"credentialRef": "cred", "generation": 4, "resourceOwnerId": "2", "state": "active"}
			identity := map[string]any{"identityId": "bot", "login": "bot", "botUserId": "10", "revision": 1, "credentials": []any{credential}}
			switch method {
			case "initialize":
				return map[string]any{}, nil
			case "initialized":
				return nil, nil
			case "litch/external/identities/list":
				if _, found := params["token"]; found {
					t.Error("读取请求不该带令牌")
				}
				return map[string]any{"identities": []any{identity}}, nil
			case "litch/external/identities/rotate":
				if params["token"] != secret || params["expectedGeneration"] != float64(4) {
					t.Error("轮换应使用 stdin 令牌和读到的凭据代次")
				}
				if fail {
					return nil, &deviceRPCError{Code: -32602, Message: secret}
				}
				return map[string]any{"identity": identity}, nil
			default:
				t.Error("令牌不应经过 litch_config")
				return nil, &deviceRPCError{Code: -32601}
			}
		}
		device.mu.Unlock()

		var stdout, stderr bytes.Buffer
		code := configMain(context.Background(), []string{
			"device-identity", "rotate", "bot", "cred", "--stdin", "--json",
		}, machineIO{stdin: strings.NewReader(secret + "\n"), stdout: &stdout, stderr: &stderr,
			env: envOf(map[string]string{deviceSocketEnvironment: device.socket})})
		if (code == 0) == fail || strings.Contains(stdout.String()+stderr.String(), secret) {
			t.Fatalf("退出码不符合预期或输出泄漏秘密，code = %d", code)
		}
		if !fail && !strings.Contains(stdout.String(), `"identityId":"bot"`) {
			t.Fatal("没有返回公开身份")
		}
	}
}

func TestConfigExternalOAuthPrintsCodeAndWaitsForRemoteDevice(t *testing.T) {
	device := startFakeDevice(t)
	device.answer = func(method string, params map[string]any) (any, *deviceRPCError) {
		if method != clientToolInvokeMethod {
			t.Error("远程 CLI 登录应通过配置桥")
			return nil, &deviceRPCError{Code: -32601}
		}
		args := params["arguments"].(map[string]any)["argv"].([]any)
		if args[1] == "add" {
			return textResult(true, `{"ok":true,"op":"device-identity add","data":{"loginId":"login-1","state":"waiting","userCode":"ABCD-1234","verificationUrl":"https://github.com/login/device"},"text":""}`), nil
		}
		if args[1] != "login" || args[2] != "status" || args[3] != "login-1" || args[5] != "build" {
			t.Errorf("登录查询未保留目标设备或登录 ID: %v", args)
		}
		return textResult(true, `{"ok":true,"op":"device-identity login","data":{"loginId":"login-1","state":"succeeded","needsConfirmation":false},"text":"@bot · 123"}`), nil
	}
	var stdout, stderr bytes.Buffer
	code := configMain(context.Background(), []string{
		"device-identity", "add", "--device=build", "--scopes", "workflow", "--json",
	}, machineIO{stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr,
		env: envOf(map[string]string{deviceSocketEnvironment: device.socket})})
	if code != 0 || !strings.Contains(stderr.String(), "ABCD-1234") ||
		strings.Contains(stdout.String(), "ABCD-1234") ||
		!strings.Contains(stdout.String(), `"state":"succeeded"`) {
		t.Fatalf("未先输出码并等到成功：%d, stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}
