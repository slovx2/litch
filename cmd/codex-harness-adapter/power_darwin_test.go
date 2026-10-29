//go:build darwin

package main

import (
	"context"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPowerCaffeinateArguments(t *testing.T) {
	if got := caffeinateArguments(1234); !reflect.DeepEqual(got, []string{"-i", "-w", "1234", "-t", "120"}) {
		t.Fatalf("命令参数错误: %v", got)
	}
}

// 显式启用的本机验收：只检查自己申请的断言，不受其他应用保活的干扰。
func TestPowerSystemAssertion(t *testing.T) {
	if os.Getenv("LITCH_TEST_POWER_SYSTEM") != "1" {
		t.Skip("set LITCH_TEST_POWER_SYSTEM=1 for the real macOS assertion check")
	}
	backend := systemPowerBackend{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lease, err := backend.start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lease.stop)
	pid := lease.(*caffeinateLease).process.Pid
	marker := "pid " + strconv.Itoa(pid) + "(caffeinate)"
	output, err := exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "assertions").Output()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, line := range strings.Split(string(output), "\n") {
		if strings.Contains(line, marker) {
			t.Log(strings.TrimSpace(line))
			if strings.Contains(line, "PreventUserIdleSystemSleep") {
				found = true
			}
			if strings.Contains(line, "PreventUserIdleDisplaySleep") || strings.Contains(line, "UserIsActive") {
				t.Fatal("不应阻止熄屏或模拟用户活跃")
			}
		}
	}
	if !found {
		t.Fatalf("没有找到自己进程 %d 的空闲睡眠断言", pid)
	}
	lease.stop()
	output, err = exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "assertions").Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), marker) {
		t.Fatalf("回收后进程 %d 仍持有断言", pid)
	}
	if source, err := backend.source(ctx); err != nil || (source != "ac" && source != "battery") {
		t.Fatalf("真实供电探测失败: %s %v", source, err)
	} else {
		t.Log("供电来源:", source)
	}
}
