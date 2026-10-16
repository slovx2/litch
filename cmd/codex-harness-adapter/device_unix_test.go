//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 假的设备进程：照定好的命令行取参数，监听聚合面的套接字，把收到的字节加上前缀原样送回，打印就绪行。
// 它把自己的参数和进程号记在状态目录里，用例据此核对启动命令行和有没有被重新拉起。
//
//	ok     正常；晚 delay 毫秒才开始监听并报就绪
//	crash  一启动就退出
//	hang   一直活着，但不监听也不报就绪
func writeDeviceFixture(t *testing.T, cfg configuration, mode string, delay int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(cfg.deviceMain()), 0o700); err != nil {
		t.Fatal(err)
	}
	fixture := fmt.Sprintf(`import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const state = value('--state');
fs.writeFileSync(path.join(state, 'fixture-argv.json'), JSON.stringify(args));
fs.appendFileSync(path.join(state, 'fixture-pids'), process.pid + '\n');
console.error('INTERNAL_DETAIL device stderr');
console.log('INTERNAL_DETAIL device stdout ' + 'x'.repeat(200000));
const mode = %q;
if (mode === 'crash') process.exit(1);
if (mode === 'hang') setInterval(() => {}, 1000);
else setTimeout(() => {
  const server = net.createServer((c) => { c.on('error', () => {}); c.write('device:'); c.pipe(c); });
  server.listen(value('--listen').slice(7), () => console.log('LITCH_DEVICE_READY'));
}, %d);
`, mode, delay)
	if err := os.WriteFile(cfg.deviceMain(), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
}

func deviceFixtureArguments(t *testing.T, cfg configuration) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(cfg.deviceDirectory(), "fixture-argv.json"))
	if err != nil {
		t.Fatal(err)
	}
	var args []string
	if err := json.Unmarshal(data, &args); err != nil {
		t.Fatal(err)
	}
	return args
}

// 假设备进程先后用过的进程号，每拉起一次多一个。
func deviceFixturePIDs(cfg configuration) []int {
	data, _ := os.ReadFile(filepath.Join(cfg.deviceDirectory(), "fixture-pids"))
	pids := []int{}
	for _, line := range strings.Fields(string(data)) {
		if pid, err := strconv.Atoi(line); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// 两个入口都用假运行时的配置；claude-code 在前，pi 在后。
func deviceTestConfiguration(t *testing.T) (configuration, []configuration) {
	t.Helper()
	cfg := testConfiguration(t)
	cfg.harness, cfg.claudePort, cfg.piPort = "", cfg.port, otherPort(t, cfg.port)
	entries := cfg.entries()
	for _, entry := range entries {
		writeStartFixture(t, entry)
	}
	return cfg, entries
}

func breakRuntimeFixture(t *testing.T, entry configuration) {
	t.Helper()
	if err := os.WriteFile(entry.adapter(), []byte("console.error('Claude CLI 未安装'); process.exit(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// start 多拉起一个设备进程：命令行照定好的来，只接起来了的运行时；排在 SSH 入口前面；
// 意外退出会被重新拉起；中断时一并清理。
func TestStartRunsAndRestartsDevice(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	breakRuntimeFixture(t, entries[0])
	writeDeviceFixture(t, cfg, "ok", 300)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	var pids []int
	output, _ := captureTerminal(t, func() error {
		go func() { done <- start(ctx, cfg) }()
		waitStartedHarness(t, entries[1], done)
		// SSH 入口能连的时候，聚合面必须已经就绪。
		if !canDial(cfg.deviceSocket()) {
			t.Fatal("SSH 入口先于聚合面启动")
		}
		// 中间四个是可重连终端的上限和期限：设置里没写过，带的是默认值。
		want := []string{"--listen", "unix://" + filepath.Join(cfg.home, "device", "device.sock"), "--state", filepath.Join(cfg.home, "device"),
			"--process-buffer-bytes", "2097152", "--process-limit", "32", "--process-idle-ms", "0", "--process-exited-ms", "600000",
			"--upstream", "pi=unix://" + filepath.Join(cfg.home, "pi", "runtime.sock")}
		if got := deviceFixtureArguments(t, cfg); strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Fatalf("设备进程的命令行不对:\n得到 %q\n应为 %q", got, want)
		}
		if info, err := os.Stat(cfg.deviceDirectory()); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("设备进程的状态目录应只有属主可进: %v %v", info, err)
		}
		if status, ok := readServiceStatus(cfg); !ok || status.State != "ready" || status.PID != os.Getpid() || status.Socket != cfg.deviceSocket() {
			t.Fatalf("服务状况不对: %+v", status)
		}
		// 杀掉设备进程，应被重新拉起，入口不受影响。
		first := deviceFixturePIDs(cfg)
		if len(first) != 1 {
			t.Fatalf("设备进程应只启动一次: %v", first)
		}
		if err := syscall.Kill(first[0], syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		waitUntil(t, "设备进程被重新拉起", func() bool {
			status, _ := readServiceStatus(cfg)
			return len(deviceFixturePIDs(cfg)) == 2 && status.State == "ready" && canDial(cfg.deviceSocket())
		})
		waitStartedHarness(t, entries[1], done)
		pids = deviceFixturePIDs(cfg)
		stopStarted(t, cancel, done)
		return nil
	})
	for _, want := range []string{"聚合面就绪: " + cfg.deviceSocket(), "设备进程意外退出"} {
		if !strings.Contains(output, want) {
			t.Fatalf("终端里缺少 %q: %s", want, output)
		}
	}
	assertCleanTerminal(t, output)
	log, err := os.ReadFile(cfg.deviceLog())
	if err != nil || !strings.Contains(string(log), "INTERNAL_DETAIL device stderr") || !strings.Contains(string(log), "INTERNAL_DETAIL device stdout") {
		t.Fatalf("设备进程的输出没有进日志: %v", err)
	}
	if canDial(cfg.deviceSocket()) || processAlive(pids[1]) {
		t.Fatal("中断后设备进程还在")
	}
	for _, leftover := range []string{cfg.deviceSocket(), cfg.serviceStatusPath()} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Fatalf("中断后没有清掉 %s", leftover)
		}
	}
	if deviceLockHeld(cfg) {
		t.Fatal("中断后设备锁没有放掉")
	}
}

func TestDeviceGetsEveryRunningRuntime(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	for _, entry := range entries {
		waitStartedHarness(t, entry, done)
	}
	got := strings.Join(deviceFixtureArguments(t, cfg), " ")
	want := "--upstream claude-code=unix://" + entries[0].socket() + " --upstream pi=unix://" + entries[1].socket()
	if !strings.HasSuffix(got, want) {
		t.Fatalf("上游应按入口顺序各传一个: %s", got)
	}
	stopStarted(t, cancel, done)
}

// 某个运行时迟迟没有结果时不干等：到时限就带着它启动设备进程（上游可以晚一点才连得上），别的入口的 SSH 不被拖住。
func TestSlowRuntimeDoesNotHoldBackTheRest(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	fixture, err := os.ReadFile(entries[0].adapter())
	if err != nil {
		t.Fatal(err)
	}
	slow := "await new Promise((resolve) => setTimeout(resolve, 1500));\n"
	if err := os.WriteFile(entries[0].adapter(), append([]byte(slow), fixture...), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := deviceSettleWait
	deviceSettleWait = 200 * time.Millisecond
	t.Cleanup(func() { deviceSettleWait = previous })
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	waitStartedHarness(t, entries[1], done)
	if canDial(entries[0].socket()) {
		t.Fatal("慢的那个运行时不该已经起来了")
	}
	got := strings.Join(deviceFixtureArguments(t, cfg), " ")
	if !strings.Contains(got, "--upstream claude-code=") || !strings.Contains(got, "--upstream pi=") {
		t.Fatalf("还没有结果的运行时也应作为上游传给设备进程: %s", got)
	}
	waitStartedHarness(t, entries[0], done)
	stopStarted(t, cancel, done)
}

// 设备进程起不来（一启动就退出，或者迟迟不报就绪）只告警：SSH 入口照样起来，后台接着重试。
func TestBrokenDeviceDoesNotBlockEntries(t *testing.T) {
	for _, mode := range []string{"crash", "hang"} {
		t.Run(mode, func(t *testing.T) {
			cfg, entries := deviceTestConfiguration(t)
			writeDeviceFixture(t, cfg, mode, 0)
			previous := deviceReadyTimeout
			deviceReadyTimeout = 300 * time.Millisecond
			t.Cleanup(func() { deviceReadyTimeout = previous })
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			output, _ := captureTerminal(t, func() error {
				go func() { done <- start(ctx, cfg) }()
				for _, entry := range entries {
					waitStartedHarness(t, entry, done)
				}
				waitUntil(t, "设备进程被再次尝试", func() bool { return len(deviceFixturePIDs(cfg)) >= 2 })
				if status, _ := readServiceStatus(cfg); status.State != "retrying" || status.Reason == "" {
					t.Fatalf("服务状况没有如实报告: %+v", status)
				}
				stopStarted(t, cancel, done)
				return nil
			})
			if !strings.Contains(output, "聚合面暂不可用") || !strings.Contains(output, "device.log") || strings.Contains(output, "聚合面就绪") {
				t.Fatalf("告警不对: %s", output)
			}
			assertCleanTerminal(t, output)
			for _, pid := range deviceFixturePIDs(cfg) {
				if processAlive(pid) {
					t.Fatalf("中断后设备进程 %d 还在", pid)
				}
			}
		})
	}
}

// 同一个状态目录上后起的 start 拿不到设备锁：不再起第二个设备进程，自己的入口照常。
func TestSecondStartLeavesDeviceToTheFirst(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	writeDeviceFixture(t, cfg, "ok", 0)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	first, second := make(chan error, 1), make(chan error, 1)
	output, _ := captureTerminal(t, func() error {
		go func() { first <- start(ctx, entries[1]) }()
		waitStartedHarness(t, entries[1], first)
		go func() { second <- start(ctx, entries[0]) }()
		waitStartedHarness(t, entries[0], second)
		if pids := deviceFixturePIDs(cfg); len(pids) != 1 {
			t.Fatalf("设备进程应只有一个: %v", pids)
		}
		if got := strings.Join(deviceFixtureArguments(t, cfg), " "); strings.Contains(got, "claude-code=") {
			t.Fatalf("后起的入口不该出现在先起的设备进程里: %s", got)
		}
		cancel()
		for _, done := range []chan error{first, second} {
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("停止超时")
			}
		}
		return nil
	})
	if !strings.Contains(output, "聚合面由另一个适配器进程提供") {
		t.Fatalf("没有说明聚合面归谁: %s", output)
	}
}

// 把测试程序当成命令行来跑（见 TestMain），自成一个会话，像一次 ssh 登录里执行的命令那样。
type cliResult struct {
	stdout, stderr string
	code, pid      int
}

// 可以在别的协程里调用，所以不在这里判失败：没能正常结束时退出码记成 -1，原因放在 stderr 里。
func runCLI(t *testing.T, stdin string, environment []string, args ...string) cliResult {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], args...)
	command.Env = append(append(os.Environ(), testCLIEnvironment+"=1", "CHA_LANG=zh-CN"), environment...)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	var stdout, stderr bytes.Buffer
	command.Stdin, command.Stdout, command.Stderr = strings.NewReader(stdin), &stdout, &stderr
	// Run 要等两条输出管道都关了才返回：被拉起的常驻服务要是还拿着它们，这里会一直等到超时。
	err := command.Run()
	result := cliResult{stdout: stdout.String(), stderr: stderr.String(), pid: command.Process.Pid}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		result.code = exit.ExitCode()
	} else if err != nil {
		result.code, result.stderr = -1, fmt.Sprintf("命令没有正常结束: %v\n%s", err, result.stderr)
	}
	return result
}

// 用例结束时把 device-start 拉起的常驻服务停掉。正常走 SIGTERM 让它自己收尾；收不掉再按这个临时目录的路径清。
func stopLaunchedService(t *testing.T, cfg configuration) {
	t.Helper()
	status, ok := readServiceStatus(cfg)
	if ok && status.PID != os.Getpid() && processAlive(status.PID) {
		_ = syscall.Kill(status.PID, syscall.SIGTERM)
		deadline := time.Now().Add(10 * time.Second)
		for processAlive(status.PID) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
	}
	// 临时目录的路径是这次用例独有的，只会碰到这次用例留下的进程。
	_ = exec.Command("pkill", "-KILL", "-f", cfg.home).Run()
}

func parseDeviceStartOutput(t *testing.T, result cliResult) deviceStartResult {
	t.Helper()
	if result.code != 0 {
		t.Fatalf("device-start 失败（退出码 %d）: %s", result.code, result.stderr)
	}
	var parsed deviceStartResult
	if strings.Count(result.stdout, "\n") != 1 || json.Unmarshal([]byte(result.stdout), &parsed) != nil {
		t.Fatalf("标准输出应只有一行 JSON: %q", result.stdout)
	}
	return parsed
}

func deviceStartArguments(cfg configuration, extra ...string) []string {
	return append([]string{"device-start", "--home", cfg.home, "--root", cfg.root,
		"--claude-port", strconv.Itoa(cfg.claudePort), "--pi-port", strconv.Itoa(cfg.piPort)}, extra...)
}
