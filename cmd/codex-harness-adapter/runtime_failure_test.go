package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeFailureReportsCurrentCodexTransportError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.log")
	previous := "Error: path must be shorter than SUN_LEN\n"
	current := "configuration token=DO-NOT-EXPOSE\nError: socket directory is not private to the current user\n"
	if err := os.WriteFile(path, []byte(previous+current), 0600); err != nil {
		t.Fatal(err)
	}
	message := both("引擎启动失败", "The engine failed to start")
	got := runtimeFailureText(configuration{harness: nativeCodex}, path, int64(len(previous)), message, errors.New("exit status 1"))
	if !strings.Contains(got.ZH, "socket directory is not private") || !strings.Contains(got.EN, "socket directory is not private") || strings.Contains(got.ZH, "DO-NOT-EXPOSE") || strings.Contains(got.ZH, "SUN_LEN") {
		t.Fatalf("具体原因缺失或泄漏了其他输出: %+v", got)
	}
	kind, text := classifyFailure(&harnessFailure{kind: stateStartFailed, text: got})
	if kind != stateStartFailed || text != got {
		t.Fatal("客户端没有得到具体原因")
	}
}

func TestRuntimeFailureDoesNotReusePreviousRunOrOtherHarnessOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.log")
	previous := "Error: socket directory is not private to the current user\n"
	if err := os.WriteFile(path, []byte(previous), 0600); err != nil {
		t.Fatal(err)
	}
	message := both("引擎启动失败", "The engine failed to start")
	cause := errors.New("exit status 0xc0000142")
	for _, c := range []configuration{{harness: nativeCodex}, {harness: claudeHarness}} {
		got := runtimeFailureText(c, path, int64(len(previous)), message, cause)
		if !strings.Contains(got.ZH, cause.Error()) || strings.Contains(got.ZH, "socket directory") {
			t.Fatalf("旧原因污染新失败: %+v", got)
		}
	}
	if got := runtimeFailureText(configuration{harness: nativeCodex}, path+".missing", 0, message, nil); got != message {
		t.Fatalf("缺日志改变了原始错误: %+v", got)
	}
}
