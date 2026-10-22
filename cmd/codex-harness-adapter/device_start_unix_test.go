//go:build !windows

package main

import (
	"context"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// 一个会把每次调用记下来的 Node：用例据此确认 --node 给的那个 Node 真的被用来跑运行时和设备进程。
func recordingNode(t *testing.T) (path, calls string) {
	t.Helper()
	real, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("测试需要 Node")
	}
	directory := t.TempDir()
	path, calls = filepath.Join(directory, "node"), filepath.Join(directory, "calls")
	script := "#!/bin/sh\necho \"$*\" >> '" + calls + "'\nexec '" + real + "' \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path, calls
}

// device-start：没有服务时以脱离会话的方式拉起并等聚合面就绪；已经在运行就直接成功，不另起一份。
func TestDeviceStartDetachesAndIsIdempotent(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 100)
	node, calls := recordingNode(t)
	t.Cleanup(func() { stopLaunchedService(t, cfg) })
	args := deviceStartArguments(cfg, "--node", node, "--ssh=off")

	first := runCLI(t, "", nil, args...)
	started := parseDeviceStartOutput(t, first)
	if !started.Ready || !started.Started || started.Socket != cfg.deviceSocket() || started.PID <= 0 || first.stderr != "" {
		t.Fatalf("第一次调用的结果不对: %+v 标准错误 %q", started, first.stderr)
	}
	if !canDial(cfg.deviceSocket()) {
		t.Fatal("返回时聚合面还连不上")
	}
	for _, entry := range entries {
		if !runtimeAnswers(entry) {
			t.Fatalf("%s 运行时没有工作", entry.harness)
		}
		if sshPortOpen(entry.port) {
			t.Fatalf("--ssh=off 没有传到常驻服务：%s 的端口开着", entry.harness)
		}
	}
	// 脱离会话：常驻服务自己是会话首进程，不在调用方那个会话里；调用方的会话被挂断后它还在。
	// （runCLI 能返回本身就说明它没有拿着调用方的输出管道。）
	if session, err := unix.Getsid(started.PID); err != nil || session != started.PID || session == first.pid {
		t.Fatalf("常驻服务没有脱离调用方的会话: 会话 %d 服务 %d 调用方 %d %v", session, started.PID, first.pid, err)
	}
	_ = syscall.Kill(-first.pid, syscall.SIGHUP)
	time.Sleep(300 * time.Millisecond)
	if !processAlive(started.PID) || !canDial(cfg.deviceSocket()) {
		t.Fatal("调用方的会话结束后服务没了")
	}
	if status, ok := readServiceStatus(cfg); !ok || status.PID != started.PID || status.State != "ready" {
		t.Fatalf("服务状况不对: %+v", status)
	}
	// --node 原样传给常驻的 start，运行时和设备进程都由它来跑。
	command, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(started.PID)).Output()
	if err != nil || !strings.Contains(string(command), " start ") || !strings.Contains(string(command), "--node "+node) || !strings.Contains(string(command), "--ssh=off") {
		t.Fatalf("常驻服务的命令行不对: %s %v", command, err)
	}
	recorded, _ := os.ReadFile(calls)
	for _, script := range []string{entries[0].adapter() + " app-server", entries[1].adapter() + " app-server", cfg.deviceMain() + " --listen"} {
		if !strings.Contains(string(recorded), script) {
			t.Fatalf("没有用 --node 指定的 Node 去跑 %s:\n%s", script, recorded)
		}
	}

	second := parseDeviceStartOutput(t, runCLI(t, "", nil, args...))
	if !second.Ready || second.Started || second.PID != started.PID || second.Socket != started.Socket {
		t.Fatalf("第二次调用应直接用已有的服务: %+v", second)
	}
	if pids := deviceFixturePIDs(cfg); len(pids) != 1 {
		t.Fatalf("不该另起一份设备进程: %v", pids)
	}

	// 服务收到终止信号后把运行时和设备进程一并收掉。
	devices := deviceFixturePIDs(cfg)
	if err := syscall.Kill(started.PID, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "常驻服务退出", func() bool { return !processAlive(started.PID) })
	if canDial(cfg.deviceSocket()) || canDial(entries[0].socket()) || canDial(entries[1].socket()) || processAlive(devices[0]) {
		t.Fatal("服务退出后还有进程留着")
	}
}

// 两个 device-start 同时来，只起一份服务，两边都成功。
func TestConcurrentDeviceStartsShareOneService(t *testing.T) {
	cfg, _ := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 200)
	t.Cleanup(func() { stopLaunchedService(t, cfg) })
	results := make(chan cliResult, 2)
	for range 2 {
		go func() { results <- runCLI(t, "", nil, deviceStartArguments(cfg, "--ssh=off")...) }()
	}
	first, second := parseDeviceStartOutput(t, <-results), parseDeviceStartOutput(t, <-results)
	if first.Started == second.Started || first.PID != second.PID {
		t.Fatalf("应当一个拉起、一个直接用: %+v %+v", first, second)
	}
	if pids := deviceFixturePIDs(cfg); len(pids) != 1 {
		t.Fatalf("设备进程应只有一个: %v", pids)
	}
}

// 新版服务还在启动（设备锁有人拿着、聚合面还没好）：等它，不另起。
func TestDeviceStartWaitsForServiceThatIsStarting(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 800)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	waitUntil(t, "服务拿住设备锁", func() bool { return deviceLockHeld(cfg) })
	result := parseDeviceStartOutput(t, runCLI(t, "", nil, deviceStartArguments(cfg)...))
	if result.Started || result.PID != os.Getpid() {
		t.Fatalf("应当等到已有的服务: %+v", result)
	}
	if pids := deviceFixturePIDs(cfg); len(pids) != 1 {
		t.Fatalf("不该另起一份: %v", pids)
	}
	for _, entry := range entries {
		waitStartedHarness(t, entry, done)
	}
	stopStarted(t, cancel, done)
}

func listTree(t *testing.T, root string) string {
	t.Helper()
	names := []string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil {
			names = append(names, path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(names, "\n")
}

// 状态目录上有一份不带聚合面的服务在跑：退出码 3，不另起、不停它、不往它的状态目录里写任何东西。
func TestDeviceStartLeavesServiceWithoutAggregateAlone(t *testing.T) {
	t.Run("旧版服务", func(t *testing.T) {
		cfg, entries := deviceTestConfiguration(t)
		writeDeviceFixture(t, cfg, "ok", 0)
		// 旧版服务的样子：某个 harness 的运行时套接字能连，没有 device 目录，也没有设备锁。
		if err := os.MkdirAll(entries[1].directory(), 0o700); err != nil {
			t.Fatal(err)
		}
		listener, err := net.Listen("unix", entries[1].socket())
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		go func() {
			for {
				connection, err := listener.Accept()
				if err != nil {
					return
				}
				_ = connection.Close()
			}
		}()
		t.Cleanup(func() { stopLaunchedService(t, cfg) })
		before := listTree(t, cfg.home)
		result := runCLI(t, "", nil, deviceStartArguments(cfg)...)
		if result.code != 3 || result.stdout != "" || !strings.Contains(result.stderr, "不带聚合面") || !strings.Contains(result.stderr, "升级") {
			t.Fatalf("应以退出码 3 提示升级: %d %q %q", result.code, result.stdout, result.stderr)
		}
		if strings.Count(strings.TrimSpace(result.stderr), "\n") != 0 {
			t.Fatalf("标准错误应只有一句话: %q", result.stderr)
		}
		if after := listTree(t, cfg.home); after != before {
			t.Fatalf("动了别人的状态目录:\n之前\n%s\n之后\n%s", before, after)
		}
		if !canDial(entries[1].socket()) {
			t.Fatal("原有的服务被影响了")
		}
	})
	t.Run("新版服务但没有设备进程", func(t *testing.T) {
		cfg, entries := deviceTestConfiguration(t)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- start(ctx, cfg) }()
		for _, entry := range entries {
			waitStartedHarness(t, entry, done)
		}
		result := runCLI(t, "", nil, deviceStartArguments(cfg)...)
		if result.code != 3 || result.stdout != "" || !strings.Contains(result.stderr, "不带聚合面") || !strings.Contains(result.stderr, "没有找到设备进程的构建产物") {
			t.Fatalf("应以退出码 3 说明原因: %d %q %q", result.code, result.stdout, result.stderr)
		}
		for _, entry := range entries {
			waitStartedHarness(t, entry, done)
		}
		stopStarted(t, cancel, done)
	})
}

// 一个 harness 都起不来（全新的机器上什么都没装）不算拉起失败：聚合面给得出来，服务就留着，
// device-start 照样以 0 返回。客户端连上去才看得到各自的原因，才有地方改设置再试。
func TestDeviceStartSucceedsWhenNoHarnessCanStart(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	breakRuntimeFixture(t, entries[0])
	breakRuntimeFixture(t, entries[1])
	t.Cleanup(func() { stopLaunchedService(t, cfg) })
	result := runCLI(t, "", nil, deviceStartArguments(cfg)...)
	started := parseDeviceStartOutput(t, result)
	if !started.Ready || !started.Started || started.Socket != cfg.deviceSocket() || started.PID <= 0 || result.stderr != "" {
		t.Fatalf("应当照常成功: %+v 标准错误 %q", started, result.stderr)
	}
	if !canDial(cfg.deviceSocket()) {
		t.Fatal("返回时聚合面还连不上")
	}
	if status, ok := readServiceStatus(cfg); !ok || status.PID != started.PID || status.State != "ready" {
		t.Fatalf("服务状况不对: %+v", status)
	}
	if got := strings.Join(deviceFixtureArguments(t, cfg), " "); strings.Contains(got, "--upstream") {
		t.Fatalf("没起来的 harness 不该作为上游传给设备进程: %s", got)
	}
	// 服务的输出里：每个入口各自的原因，加一句为什么留着；没有“没有可用入口”的收场白。
	var output string
	waitUntil(t, "服务说明了为什么留着", func() bool {
		data, _ := os.ReadFile(filepath.Join(cfg.logsDirectory(), "service.log"))
		output = string(data)
		return strings.Contains(output, "现在没有可用的 harness")
	})
	for _, expected := range []string{"警告：claude-code: ", "警告：pi: ", "留着聚合面让 Litch 能连上"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("服务的输出里缺少 %q:\n%s", expected, output)
		}
	}
	if strings.Contains(output, "没有可用的适配器入口") {
		t.Fatalf("服务不该照没有可用入口收场:\n%s", output)
	}
	time.Sleep(300 * time.Millisecond)
	if !processAlive(started.PID) || !canDial(cfg.deviceSocket()) || canDial(entries[0].socket()) || canDial(entries[1].socket()) {
		t.Fatal("服务应当留着，而且没有运行时在跑")
	}
	// 再来一次直接用这份服务，不另起。
	if again := parseDeviceStartOutput(t, runCLI(t, "", nil, deviceStartArguments(cfg)...)); again.Started || again.PID != started.PID {
		t.Fatalf("第二次调用应直接用已有的服务: %+v", again)
	}
	devices := deviceFixturePIDs(cfg)
	if err := syscall.Kill(started.PID, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "常驻服务退出", func() bool { return !processAlive(started.PID) })
	if canDial(cfg.deviceSocket()) || len(devices) != 1 || processAlive(devices[0]) {
		t.Fatalf("服务退出后设备进程还留着: %v", devices)
	}
}

// 拉起失败或等不到聚合面：退出码 1，标准错误里说清原因，自己拉起的那份服务不留着。
func TestDeviceStartFailuresAreExplained(t *testing.T) {
	stopped := func(t *testing.T, cfg configuration, entries []configuration) {
		t.Helper()
		waitUntil(t, "没成的服务被收掉", func() bool {
			return !deviceLockHeld(cfg) && !canDial(entries[0].socket()) && !canDial(entries[1].socket())
		})
	}
	expect := func(t *testing.T, result cliResult, messages ...string) {
		t.Helper()
		if result.code != 1 || result.stdout != "" {
			t.Fatalf("应以退出码 1 失败且标准输出为空: %d %q %q", result.code, result.stdout, result.stderr)
		}
		for _, message := range messages {
			if !strings.Contains(result.stderr, message) {
				t.Fatalf("标准错误里缺少 %q: %s", message, result.stderr)
			}
		}
	}
	t.Run("这份适配器没有设备进程", func(t *testing.T) {
		cfg, entries := deviceTestConfiguration(t)
		t.Cleanup(func() { stopLaunchedService(t, cfg) })
		expect(t, runCLI(t, "", nil, deviceStartArguments(cfg)...), "给不出聚合面", "没有找到设备进程的构建产物")
		stopped(t, cfg, entries)
	})
	t.Run("等聚合面超时", func(t *testing.T) {
		cfg, entries := deviceTestConfiguration(t)
		writeDeviceFixture(t, cfg, "hang", 0)
		t.Cleanup(func() { stopLaunchedService(t, cfg) })
		expect(t, runCLI(t, "", []string{testCLIEnvironment + "_TIMEOUT_MS=1500"}, deviceStartArguments(cfg)...), "等聚合面就绪超时")
		stopped(t, cfg, entries)
	})
	t.Run("找不到 Node", func(t *testing.T) {
		cfg, entries := deviceTestConfiguration(t)
		writeDeviceFixture(t, cfg, "ok", 0)
		t.Cleanup(func() { stopLaunchedService(t, cfg) })
		expect(t, runCLI(t, "", nil, deviceStartArguments(cfg, "--node", filepath.Join(cfg.home, "missing", "node"))...), "找不到 --node 指定的 Node.js")
		stopped(t, cfg, entries)
	})
}

// device-proxy 只做字节转发：标准输出里只有聚合面来的字节，标准输入读完后把“写完了”传过去。
func TestDeviceProxyOnlyForwardsBytes(t *testing.T) {
	cfg := testConfiguration(t)
	missing := runCLI(t, "hello", nil, "device-proxy", "--home", cfg.home)
	if missing.code != 1 || missing.stdout != "" || !strings.Contains(missing.stderr, "device-start") {
		t.Fatalf("聚合面没在时应失败且标准输出为空: %d %q %q", missing.code, missing.stdout, missing.stderr)
	}
	if err := os.MkdirAll(cfg.deviceDirectory(), 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", cfg.deviceSocket())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	received := make(chan string, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		// 读到对面关了写的一头为止，再把收到的原样送回去。
		data, _ := io.ReadAll(connection)
		received <- string(data)
		_, _ = connection.Write(append([]byte("device:"), data...))
	}()
	payload := "GET / HTTP/1.1\r\n\x00\x01\xff 中文\n"
	result := runCLI(t, payload, nil, "device-proxy", "--home", cfg.home)
	if result.code != 0 || result.stdout != "device:"+payload || result.stderr != "" {
		t.Fatalf("转发结果不对: %d %q %q", result.code, result.stdout, result.stderr)
	}
	select {
	case got := <-received:
		if got != payload {
			t.Fatalf("聚合面收到的不是原样的字节: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("聚合面没有收到数据")
	}
}
