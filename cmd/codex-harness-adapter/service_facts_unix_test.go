//go:build !windows

package main

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 用例自己把设备锁拿住，扮演“这个状态目录上有一份别的服务”。
func holdDeviceLock(t *testing.T, cfg configuration) {
	t.Helper()
	if err := os.MkdirAll(cfg.deviceDirectory(), 0o700); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(cfg.deviceDirectory(), "serve.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
}

// 一个只接受连接的套接字，顶在聚合面的位置上。
func listenAt(t *testing.T, path string) {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_ = connection.Close()
		}
	}()
}

// 一个接上就不放手的套接字，顶在运行时的位置上：对面关了这边才关。
func listenHolding(t *testing.T, path string) {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_, _ = io.Copy(io.Discard, connection)
				_ = connection.Close()
			}()
		}
	}()
}

// 常驻服务说得出自己是哪一份：service.json、device-start 的就绪行、控制通道的 state 里是同一份来历。
// 就绪行里另有执行这条命令的那份适配器，换一份（版本不同）来问，两边能比。
func TestServiceReportsItsFacts(t *testing.T) {
	cfg, _ := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	t.Cleanup(func() { stopLaunchedService(t, cfg) })
	args := deviceStartArguments(cfg, "--ssh=off")
	before := time.Now().Add(-2 * time.Second)

	first := parseDeviceStartOutput(t, runCLI(t, "", []string{testCLIEnvironment + "_VERSION=1.4.0"}, args...))
	facts := first.Service
	if !first.Started || facts == nil {
		t.Fatalf("就绪行里没有服务的来历: %+v", first)
	}
	if facts.PID != first.PID || facts.Version != "1.4.0" || facts.Root != cfg.root || !facts.Detached || facts.Build == "" {
		t.Fatalf("服务的来历不对: %+v", facts)
	}
	startedAt, err := time.Parse(time.RFC3339, facts.StartedAt)
	if err != nil || startedAt.Before(before) || startedAt.After(time.Now().Add(2*time.Second)) {
		t.Fatalf("启动时间不对: %q %v", facts.StartedAt, err)
	}
	// 启动参数里当默认值用的那一部分原样记着：换版本重新拉起时照它带上。
	want := []string{"--ssh=off", "--claude-port", strconv.Itoa(cfg.claudePort), "--pi-port", strconv.Itoa(cfg.piPort), "--dsh-port", "7333"}
	if !reflect.DeepEqual(facts.Options, want) {
		t.Fatalf("记下的启动参数不对:\n得到 %q\n应为 %q", facts.Options, want)
	}
	// 拉起服务的就是执行这条命令的这一份：版本、根目录、程序文件的戳都一样。
	if first.CLI != (cliFacts{Version: "1.4.0", Root: cfg.root, Build: facts.Build}) {
		t.Fatalf("就绪行里这份适配器自己的信息不对: %+v", first.CLI)
	}
	if status, ok := readServiceStatus(cfg); !ok || !reflect.DeepEqual(status.Service, facts) {
		t.Fatalf("service.json 里的来历和就绪行不一致: %+v", status.Service)
	}

	// 换一份更新的适配器来：服务还是原来那一份，报的是它自己的版本；命令报的是新的。
	second := parseDeviceStartOutput(t, runCLI(t, "", []string{testCLIEnvironment + "_VERSION=2.0.0"}, args...))
	if second.Started || second.PID != first.PID || !reflect.DeepEqual(second.Service, facts) || second.CLI.Version != "2.0.0" {
		t.Fatalf("第二次调用应如实报出在跑的那一份: %+v 服务 %+v", second, second.Service)
	}

	// 设备进程经控制通道拿到的也是这一份。
	state := dialControl(t, cfg).waitState("state 带着服务的来历", func(state controlState) bool { return state.Service != nil })
	if !reflect.DeepEqual(state.Service, facts) {
		t.Fatalf("控制通道上的来历不一致: %+v", state.Service)
	}
}

// 前台起的服务（不是 device-start 拉起的）不带脱离的标记：客户端据此不替它换版本。
func TestForegroundServiceIsNotMarkedDetached(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	for _, entry := range entries {
		waitStartedHarness(t, entry, done)
	}
	status, ok := readServiceStatus(cfg)
	if !ok || status.Service == nil {
		t.Fatalf("service.json 里没有来历: %+v", status)
	}
	if status.Service.Detached || status.Service.PID != os.Getpid() || status.Service.Version != selfVersion() || status.Service.Root != cfg.root {
		t.Fatalf("前台服务的来历不对: %+v", status.Service)
	}
	stopStarted(t, cancel, done)
}

// 这次改动之前的服务不报来历：就绪行里没有 service 这一项，调用方据此知道“不知道，多半更旧”。
func TestDeviceStartReportsNoFactsForAnOlderService(t *testing.T) {
	cfg := testConfiguration(t)
	holdDeviceLock(t, cfg)
	old := `{"pid":` + strconv.Itoa(os.Getpid()) + `,"state":"ready","socket":"` + cfg.deviceSocket() + `","updatedAt":"2026-10-01T00:00:00Z"}`
	if err := os.WriteFile(cfg.serviceStatusPath(), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	listenAt(t, cfg.deviceSocket())
	result := runCLI(t, "", []string{testCLIEnvironment + "_VERSION=2.0.0"}, "device-start", "--home", cfg.home, "--root", cfg.root)
	parsed := parseDeviceStartOutput(t, result)
	if parsed.Started || parsed.PID != os.Getpid() || parsed.Service != nil || parsed.CLI.Version != "2.0.0" {
		t.Fatalf("旧版服务的就绪行不对: %+v", parsed)
	}
	if strings.Contains(result.stdout, `"service"`) {
		t.Fatalf("旧版服务没报来历，就绪行里不该有这一项: %s", result.stdout)
	}
}

// 不带 --node 时先用随这份适配器带的那一份 Node，没有才是 PATH 里的；显式给了的不变。
func TestDefaultNodePrefersTheBundledOne(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	parse := func(extra ...string) configuration {
		t.Helper()
		cfg, err := parseConfiguration(append([]string{"--home", home, "--root", root}, extra...))
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	if got := parse().node; got != "node" {
		t.Fatalf("没有随包的 Node 时应是 PATH 里的 node: %s", got)
	}
	bundled := filepath.Join(root, "node", "bin", "node")
	if err := os.MkdirAll(bundled, 0o700); err != nil {
		t.Fatal(err)
	}
	// 那个位置上是个目录，不是 Node：不用它。
	if got := parse().node; got != "node" {
		t.Fatalf("随包的位置上不是文件时不该用它: %s", got)
	}
	if err := os.Remove(bundled); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundled, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := parse().node; got != bundled {
		t.Fatalf("应当用随包的 Node: %s", got)
	}
	for _, given := range []string{"node", "/somewhere/else/node"} {
		if got := parse("--node", given).node; got != given {
			t.Fatalf("显式给的 --node 不该被改掉: 给的 %s 得到 %s", given, got)
		}
	}
}

// 启动参数里当默认值用的那一部分，照命令行给的原样记下来。
func TestLaunchOptionsAreRecordedAsGiven(t *testing.T) {
	cases := map[string][]string{
		"":                                       {"--ssh=on", "--claude-port", "7331", "--pi-port", "7332", "--dsh-port", "7333"},
		"--ssh=off --claude-port 7441":           {"--ssh=off", "--claude-port", "7441", "--pi-port", "7332", "--dsh-port", "7333"},
		"--harness pi --port 7500 --ssh=off":     {"--ssh=off", "--claude-port", "7331", "--pi-port", "7332", "--dsh-port", "7333", "--harness", "pi", "--port", "7500"},
		"--harness dsh --dsh-port 7600 --ssh=on": {"--ssh=on", "--claude-port", "7331", "--pi-port", "7332", "--dsh-port", "7600", "--harness", "dsh", "--port", "7600"},
	}
	for args, want := range cases {
		cfg, err := parseConfiguration(append([]string{"--home", t.TempDir()}, strings.Fields(args)...))
		if err != nil || !reflect.DeepEqual(cfg.launch, want) {
			t.Fatalf("%q 记下的启动参数不对: %q %v", args, cfg.launch, err)
		}
		// 再照它解析一遍，得到的还是它：重新拉起时带上的就是原样。
		again, err := parseConfiguration(append([]string{"--home", t.TempDir()}, cfg.launch...))
		if err != nil || !reflect.DeepEqual(again.launch, want) {
			t.Fatalf("%q 记下的启动参数不能原样再用: %q %v", args, again.launch, err)
		}
	}
}
