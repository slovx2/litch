//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

func deviceStopArguments(cfg configuration, extra ...string) []string {
	return append([]string{"device-stop", "--home", cfg.home, "--root", cfg.root}, extra...)
}

// device-stop 的结果：退出码对得上，标准输出只有一行 JSON，标准错误只有一句话。
func parseDeviceStopOutput(t *testing.T, result cliResult, code int) deviceStopResult {
	t.Helper()
	if result.code != code {
		t.Fatalf("device-stop 的退出码应为 %d，实际 %d: %q %q", code, result.code, result.stdout, result.stderr)
	}
	var parsed deviceStopResult
	if strings.Count(result.stdout, "\n") != 1 || json.Unmarshal([]byte(result.stdout), &parsed) != nil {
		t.Fatalf("标准输出应只有一行 JSON: %q", result.stdout)
	}
	if strings.TrimSpace(result.stderr) == "" || strings.Count(strings.TrimSpace(result.stderr), "\n") != 0 {
		t.Fatalf("标准错误应只有一句话: %q", result.stderr)
	}
	return parsed
}

// 一个和适配器毫不相干的进程：用例拿它的进程号去冒充“记录里的服务”，看它会不会被误伤。
func bystander(t *testing.T) int {
	t.Helper()
	command := exec.Command("sleep", "120")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	return command.Process.Pid
}

func writeStaleStatus(t *testing.T, cfg configuration, pid int) {
	t.Helper()
	if err := os.MkdirAll(cfg.deviceDirectory(), 0o700); err != nil {
		t.Fatal(err)
	}
	status := serviceStatus{PID: pid, State: "ready", Socket: cfg.deviceSocket(), UpdatedAt: "2026-10-01T00:00:00Z"}
	if err := writePrivateJSON(cfg.serviceStatusPath(), status); err != nil {
		t.Fatal(err)
	}
}

// 没有服务在跑就是成功：什么都不建、什么都不动。记录里留着的进程号哪怕还活着，也不碰它。
func TestDeviceStopIsIdempotentAndNeverTrustsARecordedPID(t *testing.T) {
	t.Run("状态目录是空的", func(t *testing.T) {
		cfg := testConfiguration(t)
		before := listTree(t, cfg.home)
		result := parseDeviceStopOutput(t, runCLI(t, "", nil, deviceStopArguments(cfg)...), 0)
		if !reflect.DeepEqual(result, deviceStopResult{Result: stopResultNotRunning}) {
			t.Fatalf("结果不对: %+v", result)
		}
		if after := listTree(t, cfg.home); after != before {
			t.Fatalf("没有服务时不该往状态目录里放东西:\n%s", after)
		}
	})
	t.Run("记录是过期的，那个进程号上是别的进程", func(t *testing.T) {
		cfg := testConfiguration(t)
		innocent := bystander(t)
		writeStaleStatus(t, cfg, innocent)
		for _, extra := range [][]string{nil, {"--if-idle"}} {
			result := parseDeviceStopOutput(t, runCLI(t, "", nil, deviceStopArguments(cfg, extra...)...), 0)
			if result.Result != stopResultNotRunning || result.PID != 0 {
				t.Fatalf("没人拿着设备锁就是没有服务: %+v", result)
			}
		}
		if !processAlive(innocent) {
			t.Fatal("凭过期的进程号结束了不相干的进程")
		}
	})
}

// 设备锁有人拿着，却不是一份能请它停的服务：退出码 5，谁也不动。
func TestDeviceStopLeavesWhatItCannotAskAlone(t *testing.T) {
	t.Run("拿着锁的没有控制通道", func(t *testing.T) {
		cfg := testConfiguration(t)
		innocent := bystander(t)
		holdDeviceLock(t, cfg)
		writeStaleStatus(t, cfg, innocent)
		output := runCLI(t, "", nil, deviceStopArguments(cfg)...)
		result := parseDeviceStopOutput(t, output, exitStopNotSupported)
		if result.Result != stopResultUnsupported || !strings.Contains(output.stderr, "控制通道连不上") {
			t.Fatalf("结果不对: %+v %q", result, output.stderr)
		}
		if !processAlive(innocent) {
			t.Fatal("结束了记录里的那个进程：它不是拿着设备锁的服务")
		}
	})
	t.Run("这次改动之前的服务，不认识停止的请求", func(t *testing.T) {
		cfg := testConfiguration(t)
		innocent := bystander(t)
		holdDeviceLock(t, cfg)
		writeStaleStatus(t, cfg, innocent)
		// 旧版的控制通道：认得的命令里没有 service.stop，照它的原话答一个 error。
		listener, err := hostplatform.Listen(hostplatform.ControlSocketPath(cfg.deviceDirectory()))
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		var asked atomic.Value
		go func() {
			for {
				connection, err := listener.Accept()
				if err != nil {
					return
				}
				go func() {
					defer connection.Close()
					_, _ = connection.Write([]byte(`{"method":"state","params":{"keys":[],"harnesses":[]}}` + "\n"))
					line, err := bufio.NewReader(connection).ReadBytes('\n')
					if err != nil {
						return
					}
					asked.Store(string(line))
					_, _ = connection.Write([]byte(`{"id":1,"error":{"reason":"failed","text":{"zh-CN":"不认识的控制命令 service.stop","en":"Unknown control command service.stop"}}}` + "\n"))
					_, _ = bufio.NewReader(connection).ReadBytes('\n')
				}()
			}
		}()
		output := runCLI(t, "", nil, deviceStopArguments(cfg, "--if-idle")...)
		result := parseDeviceStopOutput(t, output, exitStopNotSupported)
		if result.Result != stopResultUnsupported || result.PID != innocent || result.Service != nil {
			t.Fatalf("结果不对: %+v", result)
		}
		for _, expected := range []string{"不认识停止的请求", strconv.Itoa(innocent)} {
			if !strings.Contains(output.stderr, expected) {
				t.Fatalf("说明里缺少 %q: %s", expected, output.stderr)
			}
		}
		if sent, _ := asked.Load().(string); !strings.Contains(sent, `"method":"service.stop"`) || !strings.Contains(sent, `"ifIdle":true`) {
			t.Fatalf("发给服务的请求不对: %q", sent)
		}
		if !processAlive(innocent) {
			t.Fatal("停不了就不该动任何进程")
		}
	})
	t.Run("聚合面有人提供，却没有人拿着设备锁", func(t *testing.T) {
		cfg := testConfiguration(t)
		if err := os.MkdirAll(cfg.deviceDirectory(), 0o700); err != nil {
			t.Fatal(err)
		}
		listenAt(t, cfg.deviceSocket())
		output := runCLI(t, "", nil, deviceStopArguments(cfg)...)
		if result := parseDeviceStopOutput(t, output, exitStopNotSupported); result.Result != stopResultUnsupported || !strings.Contains(output.stderr, "没有人拿着设备锁") {
			t.Fatalf("结果不对: %+v %q", result, output.stderr)
		}
		if !canDial(cfg.deviceSocket()) {
			t.Fatal("别人的聚合面被影响了")
		}
	})
	t.Run("不带聚合面的旧版服务", func(t *testing.T) {
		cfg, entries := deviceTestConfiguration(t)
		if err := os.MkdirAll(entries[1].directory(), 0o700); err != nil {
			t.Fatal(err)
		}
		listenAt(t, entries[1].socket())
		before := listTree(t, cfg.home)
		output := runCLI(t, "", nil, deviceStopArguments(cfg)...)
		result := parseDeviceStopOutput(t, output, exitServiceWithoutAggregate)
		if result.Result != stopResultLegacy || result.Harness != "pi" || !strings.Contains(output.stderr, "不带聚合面") {
			t.Fatalf("结果不对: %+v %q", result, output.stderr)
		}
		if after := listTree(t, cfg.home); after != before || !canDial(entries[1].socket()) {
			t.Fatal("动了别人的服务或者它的状态目录")
		}
	})
}

// 把 device-start 拉起的服务停掉：等它退干净才返回；再停一次还是成功；紧跟着再拉起，新的服务是完整的。
func TestDeviceStopStopsTheServiceAndWaits(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	t.Cleanup(func() { stopLaunchedService(t, cfg) })
	started := parseDeviceStartOutput(t, runCLI(t, "", nil, deviceStartArguments(cfg, "--ssh=off")...))
	devices := deviceFixturePIDs(cfg)

	// 带 --if-idle：假的设备进程不会回答忙不忙，两个运行时都在跑，判断不了就不停。
	busy := parseDeviceStopOutput(t, runCLI(t, "", nil, deviceStopArguments(cfg, "--if-idle")...), exitServiceBusy)
	want := []busyReason{{Reason: "undetermined", Harnesses: []string{"claude-code", "pi"}}}
	if busy.Result != stopResultBusy || busy.PID != started.PID || !reflect.DeepEqual(busy.Busy, want) || !reflect.DeepEqual(busy.Service, started.Service) {
		t.Fatalf("不闲时的结果不对: %+v", busy)
	}
	if !processAlive(started.PID) || !canDial(cfg.deviceSocket()) || !runtimeAnswers(entries[0]) {
		t.Fatal("说了不停，服务却受了影响")
	}

	stopped := parseDeviceStopOutput(t, runCLI(t, "", nil, deviceStopArguments(cfg)...), 0)
	if stopped.Result != stopResultStopped || stopped.PID != started.PID || !reflect.DeepEqual(stopped.Service, started.Service) {
		t.Fatalf("停掉之后的结果不对: %+v", stopped)
	}
	// 返回时已经收干净了：进程、设备锁、套接字、状况文件都不在了。
	if processAlive(started.PID) || deviceLockHeld(cfg) || len(devices) != 1 || processAlive(devices[0]) {
		t.Fatalf("返回时服务还没有退干净: 服务 %v 设备进程 %v", processAlive(started.PID), devices)
	}
	for _, socket := range []string{cfg.deviceSocket(), entries[0].socket(), entries[1].socket(), hostplatform.ControlSocketPath(cfg.deviceDirectory())} {
		if canDial(socket) {
			t.Fatalf("返回时 %s 还连得上", socket)
		}
	}
	if _, err := os.Stat(cfg.serviceStatusPath()); !os.IsNotExist(err) {
		t.Fatal("返回时 service.json 还在")
	}
	if again := parseDeviceStopOutput(t, runCLI(t, "", nil, deviceStopArguments(cfg)...), 0); again.Result != stopResultNotRunning {
		t.Fatalf("再停一次应当是没在运行: %+v", again)
	}
	// 停完紧跟着拉起：新服务的控制通道在（旧服务收场时不能把新服务的套接字删掉）。
	fresh := parseDeviceStartOutput(t, runCLI(t, "", nil, deviceStartArguments(cfg, "--ssh=off")...))
	if !fresh.Started || fresh.PID == started.PID {
		t.Fatalf("停掉之后应当拉起一份新的: %+v", fresh)
	}
	dialControl(t, cfg)
}

// 带 --if-idle 时服务去问设备进程忙不忙，几样里有一样就不停，并说明是哪一样；都没有才停。
func TestDeviceStopIfIdleAsksTheDeviceProcess(t *testing.T) {
	cfg, _, device, stop := startManaged(t)
	defer stop()
	environment := []string{testCLIEnvironment + "_STOP_GRACE_MS=50"}
	answer := func(activity *deviceActivity) {
		device.mu.Lock()
		defer device.mu.Unlock()
		if device.activity = nil; activity != nil {
			device.activity = func() deviceActivity { return *activity }
		}
	}
	cases := []struct {
		name     string
		activity *deviceActivity
		want     []busyReason
		say      string
	}{
		{"有回合在跑", &deviceActivity{Turns: []string{"pi"}}, []busyReason{{Reason: "activeTurns", Harnesses: []string{"pi"}}}, "pi 有回合在跑"},
		{"有属于设备的终端在跑", &deviceActivity{Processes: 2}, []busyReason{{Reason: "deviceProcesses", Count: 2}}, "有 2 个属于设备的终端在跑"},
		{"有定时任务在跑", &deviceActivity{Tasks: 1}, []busyReason{{Reason: "tasks", Count: 1}}, "有 1 次定时任务的运行在跑"},
		{"有别的客户端连着", &deviceActivity{Connections: 1}, []busyReason{{Reason: "clients", Count: 1}}, "有 1 个客户端连着"},
		{"三样都有", &deviceActivity{Turns: []string{"claude-code", "pi"}, Processes: 1, Connections: 3}, []busyReason{
			{Reason: "activeTurns", Harnesses: []string{"claude-code", "pi"}}, {Reason: "deviceProcesses", Count: 1}, {Reason: "clients", Count: 3},
		}, "claude-code、pi 有回合在跑（或者判断不了）；有 1 个属于设备的终端在跑；有 3 个客户端连着"},
		// 连着控制通道的那一头答不上（它不是设备进程），而运行时在跑：按判断不了算。
		{"设备进程答不上", nil, []busyReason{{Reason: "undetermined", Harnesses: []string{"claude-code", "pi"}}}, "判断不了 claude-code、pi 有没有回合在跑"},
	}
	for _, item := range cases {
		answer(item.activity)
		output := runCLI(t, "", environment, deviceStopArguments(cfg, "--if-idle")...)
		result := parseDeviceStopOutput(t, output, exitServiceBusy)
		if result.Result != stopResultBusy || result.PID != os.Getpid() || !reflect.DeepEqual(result.Busy, item.want) {
			t.Fatalf("%s：结果不对: %+v", item.name, result)
		}
		if !strings.Contains(output.stderr, item.say) || !strings.Contains(output.stderr, "没有停") {
			t.Fatalf("%s：说明不对: %s", item.name, output.stderr)
		}
		if !deviceLockHeld(cfg) || !canDial(cfg.deviceSocket()) {
			t.Fatalf("%s：说了不停，服务却停了", item.name)
		}
	}
	device.mu.Lock()
	asked := device.asked
	device.mu.Unlock()
	if asked != len(cases) {
		t.Fatalf("每次都该问设备进程一遍: 问了 %d 次", asked)
	}
	answer(&deviceActivity{})
	result := parseDeviceStopOutput(t, runCLI(t, "", environment, deviceStopArguments(cfg, "--if-idle")...), 0)
	if result.Result != stopResultStopped || result.PID != os.Getpid() || result.Service == nil || result.Service.Detached {
		t.Fatalf("闲着就该停掉: %+v", result)
	}
	if deviceLockHeld(cfg) || canDial(cfg.deviceSocket()) {
		t.Fatal("返回时服务还没有收干净")
	}
}

// 经 SSH 入口连着的官方桌面端也算客户端：这一层自己数，连接结束了数就回去。
func TestDesktopSessionsCountAsClients(t *testing.T) {
	cfg := testConfiguration(t)
	manager := newHarnessManager(cfg)
	server := &controlServer{manager: manager, peers: map[net.Conn]*sync.Mutex{}, asks: map[int]*pendingAsk{}, ctx: context.Background()}
	if busy := server.busy(nil); len(busy) != 0 {
		t.Fatalf("没有运行时、没有连接时应当是闲的: %+v", busy)
	}
	if err := os.MkdirAll(cfg.directory(), 0o700); err != nil {
		t.Fatal(err)
	}
	listenHolding(t, cfg.socket())
	desktop, served := net.Pipe()
	finished := make(chan error, 1)
	go func() {
		finished <- localRuntime{socket: cfg.socket(), sessions: manager.base.desktops}.ServeDesktop(served)
	}()
	waitUntil(t, "桌面端的连接被数上", func() bool { return manager.desktops.Load() == 1 })
	if busy := server.busy(nil); !reflect.DeepEqual(busy, []busyReason{{Reason: "clients", Count: 1}}) {
		t.Fatalf("有桌面端连着时应当不闲: %+v", busy)
	}
	_ = desktop.Close()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("桌面端断开后转发没有结束")
	}
	if manager.desktops.Load() != 0 || len(server.busy(nil)) != 0 {
		t.Fatalf("连接结束后数没有回去: %d", manager.desktops.Load())
	}
}
