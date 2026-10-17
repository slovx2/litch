package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

const testCLIEnvironment = "CHA_TEST_RUN_AS_CLI"

// 测试机上可能装有 dsh、opencode、codex；默认按未安装处理，入口集合才是确定的。需要验证检测本身的用例自行恢复。
var detectDsh, detectOpencode, detectCodex = dshInstalled, opencodeInstalled, codexInstalled

func TestMain(m *testing.M) {
	// 测试要把命令行当成真的进程来跑时（device-start、device-proxy），用测试程序自己顶替。
	if os.Getenv(testCLIEnvironment) == "1" {
		dshInstalled = func(configuration) bool { return false }
		opencodeInstalled = func(configuration) bool { return false }
		codexInstalled = func(configuration) bool { return false }
		outputLanguage = chinese
		// 等聚合面的时限只在用例里要调短，不做成正式的选项。
		if value, err := strconv.Atoi(os.Getenv(testCLIEnvironment + "_TIMEOUT_MS")); err == nil {
			deviceStartTimeout = time.Duration(value) * time.Millisecond
		}
		// 测试程序旁边没有 package.json，版本号由用例给：好让“在跑的服务”和“执行命令的这一份”版本不同。
		buildVersion = os.Getenv(testCLIEnvironment + "_VERSION")
		// 用例里被停的服务有时就在测试进程里，它不会退出：等进程消失的那一小会儿调短。
		if value, err := strconv.Atoi(os.Getenv(testCLIEnvironment + "_STOP_GRACE_MS")); err == nil {
			deviceStopExitGrace = time.Duration(value) * time.Millisecond
		}
		main()
		os.Exit(0)
	}
	dshInstalled = func(configuration) bool { return false }
	opencodeInstalled = func(configuration) bool { return false }
	codexInstalled = func(configuration) bool { return false }
	// 重试间隔缩短，用例不用干等。
	sshRetryDelay, deviceRestartDelay = 50*time.Millisecond, 50*time.Millisecond
	// 用例里核对的提示都是中文；输出语言不跟着跑测试的机器走。
	outputLanguage = chinese
	os.Exit(m.Run())
}

func TestDshJoinsDefaultStartOnlyWhenInstalled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("用 POSIX 可执行位构造假 dsh")
	}
	dshInstalled = detectDsh
	t.Cleanup(func() { dshInstalled = func(configuration) bool { return false } })
	empty, installed := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(installed, "dsh"), []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	// 不可执行的同名文件不算已安装。
	if err := os.WriteFile(filepath.Join(empty, "dsh"), []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	harnesses := func() []string {
		cfg, err := parseConfiguration([]string{"--home", t.TempDir(), "--dsh-port", "7555"})
		if err != nil {
			t.Fatal(err)
		}
		names := []string{}
		for _, entry := range cfg.entries() {
			names = append(names, entry.harness)
			if entry.harness == "dsh" && entry.port != 7555 {
				t.Fatalf("dsh 端口错误: %d", entry.port)
			}
		}
		return names
	}
	t.Setenv("CHA_DSH_CLI", "")
	t.Setenv("PATH", empty)
	if got := harnesses(); len(got) != 2 || got[0] != "claude-code" || got[1] != "pi" {
		t.Fatalf("没装 dsh 时不应出现 dsh 入口: %v", got)
	}
	t.Setenv("PATH", empty+string(os.PathListSeparator)+installed)
	if got := harnesses(); len(got) != 3 || got[2] != "dsh" {
		t.Fatalf("PATH 里有 dsh 时应带上 dsh 入口: %v", got)
	}
	// 显式指定路径视为用户要用 dsh；路径无效会在启动检查时告警，而不是悄悄跳过。
	t.Setenv("PATH", empty)
	t.Setenv("CHA_DSH_CLI", filepath.Join(empty, "missing"))
	if got := harnesses(); len(got) != 3 {
		t.Fatalf("设置 CHA_DSH_CLI 后应带上 dsh 入口: %v", got)
	}
}

func TestDshInstalledReadsUserEnvironmentFile(t *testing.T) {
	dshInstalled = detectDsh
	t.Cleanup(func() { dshInstalled = func(configuration) bool { return false } })
	home := t.TempDir()
	// 进程环境里已有的变量优先于环境文件（即便为空），所以这里要真正取消设置。
	t.Setenv("CHA_DSH_CLI", "")
	if err := os.Unsetenv("CHA_DSH_CLI"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	// 后台服务的环境变量写在 <home>/env，检测要与适配器看到的环境一致。
	if err := os.WriteFile(filepath.Join(home, "env"), []byte("CHA_DSH_CLI=/opt/dsh/bin/dsh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := parseConfiguration([]string{"--home", home})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.entries()) != 3 {
		t.Fatalf("环境文件里的 CHA_DSH_CLI 未生效: %+v", cfg.entries())
	}
}
