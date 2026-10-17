//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 经控制通道停用、启用一个 harness，改它的环境变量和命令行路径：运行时由这一层停、起，状态如实报出去。
func TestControlTurnsHarnessOffAndOn(t *testing.T) {
	cfg, entries, control, stop := startManaged(t)
	defer stop()
	pi := entries[1]
	first := control.waitState("收到完整的状态", func(state controlState) bool {
		return state.harness("claude-code").State == stateRunning && state.harness("pi").State == stateRunning
	})
	// 已知的 harness 都在名单里（三个老引擎、OpenCode、ACP 那三个、原生 codex），没装的 dsh、OpenCode、原生 codex
	// 说明了原因（用例里它们一律按没装），默认不启用的 ACP 那几个报停用。
	dsh := first.harness("dsh")
	if len(first.Harnesses) != 8 || dsh.State != stateNotInstalled || dsh.Text == nil || dsh.Text.ZH == "" || dsh.Text.EN == "" {
		t.Fatalf("名单应列出全部已知的 harness: %+v", first.Harnesses)
	}
	if opencode := first.harness("opencode"); opencode.State != stateNotInstalled || opencode.Text == nil || !strings.Contains(opencode.Text.ZH, "CHA_OPENCODE_CLI") {
		t.Fatalf("没装的 OpenCode 应报没装、提它自己的变量: %+v", opencode)
	}
	for _, id := range []string{"gemini", "qwen", "acp"} {
		if view := first.harness(id); view.State != stateDisabled || view.Text == nil || !strings.Contains(view.Text.ZH, "默认不启用") {
			t.Fatalf("%s 默认不启用: %+v", id, view)
		}
	}
	// 没装的原因只提它自己的那个变量，并说明设置里能填路径。
	for _, said := range []string{dsh.Text.ZH, dsh.Text.EN} {
		if !strings.Contains(said, "CHA_DSH_CLI") || !strings.Contains(said, cliPathKey("dsh")) || strings.Contains(said, "PI_CLI") || strings.Contains(said, "CHA_CLAUDE_CLI") {
			t.Fatalf("dsh 没装的原因不对: %s", said)
		}
	}
	if codex := first.harness(nativeCodex); codex.State != stateNotInstalled || !codex.Native || codex.Text == nil || !strings.Contains(codex.Text.ZH, cliPathKey(nativeCodex)) || first.harness("pi").Native {
		t.Fatalf("没装的原生 codex 应报没装、说明设置里能填路径，并标明是原生的: %+v", first.Harnesses)
	}
	if first.harness("pi").Socket != "unix://"+pi.socket() || first.Snapshot.Version != 0 || len(first.Snapshot.PendingRestart) != 0 {
		t.Fatalf("起始状态不对: %+v", first)
	}
	if _, err := os.Stat(settingsPath(cfg.home)); !os.IsNotExist(err) {
		t.Fatal("没写过设置时不该有设置文件")
	}

	// 版本号对不上的写入被拒绝，带回最新的快照。
	_, failure := control.call("settings.write", map[string]any{"expectedVersion": 7, "edits": []settingEdit{edit(enabledKey("pi"), false)}})
	if failure == nil || failure.Reason != "conflict" || failure.Snapshot == nil || failure.Snapshot.Version != 0 {
		t.Fatalf("版本号对不上应被拒绝并带回最新的快照: %+v", failure)
	}
	_, failure = control.call("settings.write", map[string]any{"expectedVersion": 0, "edits": []settingEdit{edit("ssh.pi.port", 0)}})
	if failure == nil || failure.Reason != "invalid" || failure.Key != "ssh.pi.port" {
		t.Fatalf("不合规矩的值应被拒绝并指出是哪一项: %+v", failure)
	}

	// 停用：写入只是记下来（运行时还在跑，标成待重启），重新应用之后才真的停。
	before := readFixtureEnvironment(t, pi)
	snapshot := control.write(0, edit(enabledKey("pi"), false))
	if !snapshot.pending("pi") || snapshot.pending("claude-code") || !runtimeAnswers(pi) {
		t.Fatalf("写入之后应标成待重启，运行时还在: %+v", snapshot.PendingRestart)
	}
	if !control.sawKey(enabledKey("pi")) {
		t.Fatal("设置变了没有告诉设备进程是哪个键")
	}
	result := control.apply("pi")
	if result.State != stateDisabled || result.Text == nil || result.Snapshot.pending("pi") {
		t.Fatalf("停用之后的状态不对: %+v", result)
	}
	if canDial(pi.socket()) || sshPortOpen(pi.port) || processAlive(before.PID) {
		t.Fatal("停用之后运行时或者它的 SSH 入口还在")
	}
	control.waitState("状态里是已停用", func(state controlState) bool {
		return state.harness("pi").State == stateDisabled && state.Snapshot.sshEntry("pi").State == "idle"
	})
	if !runtimeAnswers(entries[0]) {
		t.Fatal("停用一个 harness 连累了另一个")
	}

	// 再启用，同时给它一个环境变量。
	snapshot = control.write(1, edit(enabledKey("pi"), true), edit(envKey("pi"), []map[string]any{{"name": "FIXTURE_MARK", "value": "one"}}))
	if !snapshot.pending("pi") {
		t.Fatal("停用着的 harness 被启用后应等着重新应用")
	}
	if result = control.apply("pi"); result.State != stateRunning || result.Text != nil {
		t.Fatalf("启用之后没有起来: %+v", result)
	}
	// 应答里是定下来的样子：不再待重启，SSH 入口也已经听上了；应答到的时候最新的 state 已经是这样。
	if entry := result.Snapshot.sshEntry("pi"); result.Snapshot.pending("pi") || entry.State != "listening" {
		t.Fatalf("重新应用的应答应带定下来的状态: %+v", result.Snapshot)
	}
	if latest, _ := control.latest(); latest.harness("pi").State != stateRunning || latest.Snapshot.pending("pi") || latest.Snapshot.sshEntry("pi").State != "listening" {
		t.Fatalf("应答到的时候手上最新的 state 应该不比它旧: %+v", latest)
	}
	started := readFixtureEnvironment(t, pi)
	if !runtimeAnswers(pi) || started.Mark == nil || *started.Mark != "one" || started.PID == before.PID {
		t.Fatalf("重新起来的运行时没有带上设置里的环境变量: %+v", started)
	}

	// 改环境变量：没重启之前运行时还是旧的；重启之后才生效。
	snapshot = control.write(2, edit(envKey("pi"), []map[string]any{{"name": "FIXTURE_MARK", "value": "two"}}))
	if current := readFixtureEnvironment(t, pi); !snapshot.pending("pi") || current.PID != started.PID {
		t.Fatal("改了环境变量不该擅自重启")
	}
	if result = control.apply("pi"); result.State != stateRunning {
		t.Fatalf("重启没有成功: %+v", result)
	}
	if restarted := readFixtureEnvironment(t, pi); restarted.Mark == nil || *restarted.Mark != "two" || restarted.PID == started.PID {
		t.Fatalf("重启之后环境变量没有生效: %+v", restarted)
	}

	// 命令行路径指到不存在的地方：报“没装”；清掉之后再起来。
	control.write(3, edit(cliPathKey("pi"), filepath.Join(cfg.home, "no-such-cli")))
	if result = control.apply("pi"); result.State != stateNotInstalled || result.Text == nil || !strings.Contains(result.Text.ZH, "设置里给 Pi 填的“命令行路径”") || !strings.Contains(result.Text.EN, cliPathKey("pi")) {
		t.Fatalf("找不到命令行时应报没装并说明原因: %+v", result)
	}
	control.write(4, settingEdit{Key: cliPathKey("pi"), Value: json.RawMessage("null")})
	if result = control.apply("pi"); result.State != stateRunning {
		t.Fatalf("改回来之后没有起来: %+v", result)
	}
	if _, failure := control.call("harness.apply", map[string]any{"harness": "no-such-harness"}); failure == nil || failure.Reason != "unknownHarness" {
		t.Fatalf("不认识的 harness 应被拒绝: %+v", failure)
	}

	// 设置落在磁盘上，只有属主可读写；密钥不进状态。
	if info, err := os.Stat(settingsPath(cfg.home)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("设置文件应只有属主可读写: %v %v", info, err)
	}
	stop()
	if _, err := os.Stat(hostplatform.ControlSocketPath(cfg.deviceDirectory())); !os.IsNotExist(err) {
		t.Fatal("服务停了之后控制通道的套接字没有清掉")
	}
}

// SSH 入口的开关和端口改了立刻生效，不动运行时。
func TestControlMovesSSHEntryWithoutRestart(t *testing.T) {
	_, entries, control, stop := startManaged(t)
	defer stop()
	pi := entries[1]
	control.waitState("入口在听", func(state controlState) bool {
		entry := state.Snapshot.sshEntry("pi")
		return entry.State == "listening" && entry.Port == pi.port && entry.Enabled
	})
	before := readFixtureEnvironment(t, pi)
	moved := pi
	moved.port = testConfiguration(t).port
	snapshot := control.write(0, edit(sshPortKey("pi"), moved.port))
	if snapshot.pending("pi") {
		t.Fatal("改 SSH 入口不该要求重启 harness")
	}
	// 应答里就是定下来的样子：入口已经在新端口上听着，不是“正在换”的中间状态；
	// 应答到的时候，推过来的 state 里最新的那条也已经是这个样子。
	settled := func(what string, snapshot settingsSnapshot, state string, port int) {
		t.Helper()
		if entry := snapshot.sshEntry("pi"); entry.State != state || entry.Port != port {
			t.Fatalf("%s：应答里的入口应该已经定下来（%s，端口 %d）: %+v", what, state, port, entry)
		}
		latest, _ := control.latest()
		if latest.Snapshot.Version != snapshot.Version || !reflect.DeepEqual(latest.Snapshot.sshEntry("pi"), snapshot.sshEntry("pi")) {
			t.Fatalf("%s：应答到的时候手上最新的 state 应该不比它旧: %+v", what, latest.Snapshot)
		}
	}
	settled("换端口", snapshot, "listening", moved.port)
	waitStartedHarness(t, moved, nil)
	if sshPortOpen(pi.port) {
		t.Fatal("旧端口还在听")
	}
	// 换到一个被别的程序占着的端口：定下来的样子是“没起来”，原因也带着。
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	occupied := taken.Addr().(*net.TCPAddr).Port
	snapshot = control.write(1, edit(sshPortKey("pi"), occupied))
	settled("端口被占", snapshot, "failed", occupied)
	if reason := snapshot.sshEntry("pi").Reason; reason == nil || reason.Kind != "portUnavailable" {
		t.Fatalf("端口被占应说明原因: %+v", snapshot.sshEntry("pi"))
	}
	_ = taken.Close()
	snapshot = control.write(2, edit(sshPortKey("pi"), moved.port))
	settled("换回来", snapshot, "listening", moved.port)
	// 关掉入口：端口不再监听，运行时照常。
	snapshot = control.write(3, edit(sshEnabledKey("pi"), false))
	settled("关掉", snapshot, "off", moved.port)
	waitUntil(t, "端口不再监听", func() bool { return !sshPortOpen(moved.port) })
	if after := readFixtureEnvironment(t, pi); after.PID != before.PID || !runtimeAnswers(pi) {
		t.Fatal("改 SSH 入口动了运行时")
	}
	// 取 ssh 配置片段：开着的给出片段（用的是现行的端口），关着的和没初始化过的说明原因。
	var config struct {
		Entries []sshConfigEntry `json:"entries"`
		Text    string           `json:"text"`
	}
	control.must("ssh.config", nil, &config)
	if len(config.Entries) != len(adapterHarnesses) {
		t.Fatalf("每个引擎都应有一个入口: %+v", config.Entries)
	}
	claude, turnedOff, dsh := config.Entries[0], config.Entries[1], config.Entries[2]
	if claude.Config == nil || !strings.Contains(*claude.Config, "Host codex-harness-adapter-claude\n") || !strings.Contains(*claude.Config, "Port "+strconv.Itoa(entries[0].port)+"\n") || config.Text != *claude.Config {
		t.Fatalf("开着的入口没有给出片段: %+v %q", claude, config.Text)
	}
	if turnedOff.Config != nil || turnedOff.Unavailable == nil || turnedOff.Port != moved.port || dsh.Config != nil || dsh.Unavailable == nil {
		t.Fatalf("给不出片段的入口应说明原因: %+v %+v", turnedOff, dsh)
	}
}

// 诊断复用 doctor 的检查，结果是结构化的；日志能取到末尾。
func TestControlDiagnosticsAndLogs(t *testing.T) {
	cfg, entries, control, stop := startManaged(t)
	defer stop()
	control.waitState("入口在听", func(state controlState) bool { return state.Snapshot.sshEntry("pi").State == "listening" })
	// 让 Pi 的命令行“找不到”：只写不重启，诊断用的是现行的设置。
	control.write(0, edit(cliPathKey("pi"), filepath.Join(cfg.home, "no-such-cli")))
	var report struct {
		RanAt  string            `json:"ranAt"`
		Checks []diagnosticCheck `json:"checks"`
	}
	control.must("diagnostics.run", map[string]any{}, &report)
	if _, err := time.Parse(time.RFC3339, report.RanAt); err != nil {
		t.Fatalf("诊断的时间不对: %q", report.RanAt)
	}
	status := map[string]diagnosticCheck{}
	for _, check := range report.Checks {
		if check.Title.ZH == "" || check.Title.EN == "" || check.Scope.Kind != "harness" {
			t.Fatalf("检查项缺标题或者范围: %+v", check)
		}
		status[check.Scope.Harness+"/"+check.ID] = check
	}
	for key, want := range map[string]string{
		"claude-code/runtime": "ok", "claude-code/terminal": "ok", "claude-code/sshEntry": "ok",
		"pi/runtime": "failed", "pi/terminal": "skipped", "pi/sshEntry": "ok",
		"dsh/runtime": "skipped", "dsh/sshEntry": "skipped",
	} {
		if status[key].Status != want {
			t.Fatalf("%s 应为 %s: %+v", key, want, status[key])
		}
	}
	failed := status["pi/runtime"]
	if failed.Detail == nil || !strings.Contains(failed.Detail.ZH, "设置里给 Pi 填的“命令行路径”") || failed.LogPath == nil || *failed.LogPath != filepath.Join(entries[1].directory(), "diagnostics.log") {
		t.Fatalf("没过的检查应说明原因并指出日志: %+v", failed)
	}
	// 只查一个。
	control.must("diagnostics.run", map[string]any{"harness": "claude-code"}, &report)
	if len(report.Checks) != 3 {
		t.Fatalf("只查一个 harness 时应只有它的检查: %+v", report.Checks)
	}

	var tail struct {
		Path      string `json:"path"`
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
		Size      int64  `json:"size"`
	}
	control.must("logs.tail", map[string]any{"source": "diagnostics", "harness": "pi"}, &tail)
	if tail.Path != *failed.LogPath || !strings.Contains(tail.Text, "INTERNAL_DETAIL") || tail.Truncated || tail.Size == 0 {
		t.Fatalf("诊断日志没有取到: %+v", tail)
	}
	control.must("logs.tail", map[string]any{"source": "runtime", "harness": "claude-code"}, &tail)
	if !strings.Contains(tail.Text, "fixture runtime started") {
		t.Fatalf("运行日志没有取到: %+v", tail)
	}
	// 只要末尾一小段：从整行开始，说明前面还有。
	control.must("logs.tail", map[string]any{"source": "device", "maxBytes": 40}, &tail)
	if !tail.Truncated || len(tail.Text) > 40 || tail.Size <= 40 || tail.Path != cfg.deviceLog() {
		t.Fatalf("截取末尾不对: %+v", tail)
	}
	// 还没有的日志不算错。
	control.must("logs.tail", map[string]any{"source": "service"}, &tail)
	if tail.Text != "" || tail.Size != 0 {
		t.Fatalf("不存在的日志应是空的: %+v", tail)
	}
	if _, failure := control.call("logs.tail", map[string]any{"source": "runtime", "harness": "../etc"}); failure == nil || failure.Reason != "unknownHarness" {
		t.Fatalf("日志只能按已知的 harness 取: %+v", failure)
	}
}

// 一个 harness 都起不来、设置里也什么都没写过（全新的机器）：聚合面给得出来，服务就留着并说明原因。
// 毛病修好之后经控制通道再试一次就起来，SSH 入口跟着起；之后又一个都不剩时再说明一次。
func TestServiceStaysWhenNoHarnessCanStart(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	breakRuntimeFixture(t, entries[0])
	breakRuntimeFixture(t, entries[1])
	writeDeviceFixture(t, cfg, "ok", 0)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	const stays = "现在没有可用的 harness"
	output, _ := captureTerminal(t, func() error {
		go func() { done <- start(ctx, cfg) }()
		control := dialControl(t, cfg)
		state := control.waitState("两个都没起来", func(state controlState) bool {
			return state.harness("claude-code").State == stateStartFailed && state.harness("pi").State == stateStartFailed
		})
		if state.Snapshot.Version != 0 || len(state.Snapshot.Explicit) != 0 || state.harness("dsh").State != stateNotInstalled {
			t.Fatalf("设置里什么都没写过: %+v %+v", state.Snapshot, state.Harnesses)
		}
		// 没有任何上游，聚合面也要起来。
		waitUntil(t, "聚合面就绪", func() bool { return canDial(cfg.deviceSocket()) })
		if got := strings.Join(deviceFixtureArguments(t, cfg), " "); strings.Contains(got, "--upstream") {
			t.Fatalf("没起来的 harness 不该作为上游传给设备进程: %s", got)
		}
		// 服务状况是主进程发现聚合面能连之后才写的，比“能连”晚一步，所以这里要等
		waitUntil(t, "服务状况写成就绪", func() bool {
			status, ok := readServiceStatus(cfg)
			return ok && status.State == "ready"
		})
		select {
		case err := <-done:
			t.Fatalf("聚合面在，服务不该退出: %v", err)
		case <-time.After(300 * time.Millisecond):
		}
		if sshPortOpen(entries[0].port) || sshPortOpen(entries[1].port) {
			t.Fatal("没有运行时，SSH 入口不该起")
		}
		// 把 Pi 修好，再试一次：运行时和它的 SSH 入口都起来。
		writeManagedFixture(t, entries[1])
		if result := control.apply("pi"); result.State != stateRunning || !runtimeAnswers(entries[1]) {
			t.Fatalf("修好之后再试没有起来: %+v", result)
		}
		waitUntil(t, "Pi 的 SSH 入口起来", func() bool { return sshPortOpen(entries[1].port) })
		// 又一个都不剩：还是留着。
		control.write(0, edit(enabledKey("pi"), false))
		if result := control.apply("pi"); result.State != stateDisabled {
			t.Fatalf("停用没有生效: %+v", result)
		}
		select {
		case err := <-done:
			t.Fatalf("聚合面在，服务不该退出: %v", err)
		case <-time.After(300 * time.Millisecond):
		}
		stopStarted(t, cancel, done)
		return nil
	})
	// 一开始说明一次，有运行时跑起来之后又落空时再说明一次；Pi 再试之前那一轮不重复说。
	if count := strings.Count(output, stays); count != 2 {
		t.Fatalf("留着的原因应说明两次，实际 %d 次:\n%s", count, output)
	}
	// 让用户去检查环境时提的是装上的那个命令（Homebrew、独立安装包），从源码运行的写法也带着。
	for _, expected := range []string{"警告：claude-code: ", "警告：pi: ", "留着聚合面让 Litch 能连上", "codex-harness-adapter doctor", "npm run doctor"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("输出里缺少 %q:\n%s", expected, output)
		}
	}
	if strings.Contains(output, "没有可用的适配器入口") {
		t.Fatalf("不该照没有可用入口收场:\n%s", output)
	}
}

// 一个 harness 都起不来，聚合面也给不出来（这份适配器没有设备进程）：照旧，没有可用入口就退出。
func TestServiceQuitsWhenNothingStartsAndNoAggregate(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	breakRuntimeFixture(t, entries[0])
	breakRuntimeFixture(t, entries[1])
	done := make(chan error, 1)
	output, _ := captureTerminal(t, func() error {
		go func() { done <- start(t.Context(), cfg) }()
		select {
		case err := <-done:
			if err == nil || !strings.Contains(err.Error(), "没有可用的适配器入口") || !strings.Contains(err.Error(), "codex-harness-adapter doctor") {
				t.Fatalf("应照没有可用入口退出，并提装上的那个检查命令: %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("没有聚合面也没有运行时，服务应退出")
		}
		return nil
	})
	if strings.Contains(output, "现在没有可用的 harness") || !strings.Contains(output, "没有找到设备进程的构建产物") {
		t.Fatalf("不该说服务留着:\n%s", output)
	}
}

// 全部停用之后服务一样留着；设置文件里停用着的 harness 启动时就不起。
func TestServiceStaysWhenEverythingIsTurnedOff(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	for _, entry := range entries {
		writeManagedFixture(t, entry)
	}
	// Claude Code 起不来，Pi 在设置里停用着：一个运行时都没有，但服务要留着。
	breakRuntimeFixture(t, entries[0])
	writeDeviceFixture(t, cfg, "ok", 0)
	settings, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	if _, problem, err := settings.apply(0, []settingEdit{edit(enabledKey("pi"), false)}, buildSettingsSchema(cfg), nil); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	control := dialControl(t, cfg)
	state := control.waitState("两个都没在跑", func(state controlState) bool {
		return state.harness("claude-code").State == stateStartFailed && state.harness("pi").State == stateDisabled
	})
	if state.Snapshot.Version != 1 || state.Snapshot.Values[enabledKey("pi")] != false || canDial(entries[1].socket()) {
		t.Fatalf("设置里停用着的 harness 不该起: %+v", state.Snapshot)
	}
	// 没有任何上游，聚合面也要起来：不然没有地方把停用的再启用。
	waitUntil(t, "聚合面就绪", func() bool { return canDial(cfg.deviceSocket()) })
	if got := strings.Join(deviceFixtureArguments(t, cfg), " "); strings.Contains(got, "--upstream") {
		t.Fatalf("没起来的 harness 不该作为上游传给设备进程: %s", got)
	}
	select {
	case err := <-done:
		t.Fatalf("聚合面在，服务不该退出: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	control.write(1, edit(enabledKey("pi"), true))
	if result := control.apply("pi"); result.State != stateRunning || !runtimeAnswers(entries[1]) {
		t.Fatalf("再启用没有起来: %+v", result)
	}
	stopStarted(t, cancel, done)
}

// 聚合面给不出来的时候，全部停用之后和没有可用入口一样退出。
func TestServiceQuitsWithoutAggregateAndRuntimes(t *testing.T) {
	cfg, entries := deviceTestConfiguration(t)
	for _, entry := range entries {
		writeManagedFixture(t, entry)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	control := dialControl(t, cfg)
	control.waitState("都起来了", func(state controlState) bool {
		return state.harness("claude-code").State == stateRunning && state.harness("pi").State == stateRunning
	})
	control.write(0, edit(enabledKey("pi"), false), edit(enabledKey("claude-code"), false))
	control.apply("pi")
	// 最后一个停掉之后服务就退出了，这一条等不到应答。
	control.post("harness.apply", map[string]any{"harness": "claude-code"})
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "没有可用的适配器入口") {
			t.Fatalf("应照没有可用入口退出: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("没有聚合面也没有运行时，服务应退出")
	}
}

// 可重连终端的设置改了立刻生效：不标待重启、不重启设备进程，新值经控制通道推过去，下次拉起设备进程时也带上。
func TestControlPushesProcessLimitsWithoutRestart(t *testing.T) {
	cfg, entries, control, stop := startManaged(t)
	defer stop()
	first := control.waitState("收到完整的状态", func(state controlState) bool {
		return state.harness("pi").State == stateRunning && len(state.Processes) == 4
	})
	if first.Processes["bufferBytes"] != 2097152 || first.Processes["maxProcesses"] != 32 || first.Processes["idleTimeoutMs"] != 0 || first.Processes["exitedRetentionMs"] != 600000 {
		t.Fatalf("一开始推过去的应是默认值: %v", first.Processes)
	}
	waitUntil(t, "聚合面就绪", func() bool { return canDial(cfg.deviceSocket()) })
	device := deviceFixturePIDs(cfg)
	runtimeBefore := readFixtureEnvironment(t, entries[1])
	snapshot := control.write(0, edit("processes.limit", 3), edit("processes.idleMs", 120000))
	if len(snapshot.PendingRestart) != 0 || snapshot.Values["processes.limit"] != float64(3) {
		t.Fatalf("这几项不该要求重启任何 harness: %+v", snapshot)
	}
	pushed := control.waitState("新值推过来", func(state controlState) bool {
		return state.Processes["maxProcesses"] == 3 && state.Processes["idleTimeoutMs"] == 120000
	})
	if pushed.Processes["bufferBytes"] != 2097152 || pushed.Processes["exitedRetentionMs"] != 600000 {
		t.Fatalf("没改的两项不该变: %v", pushed.Processes)
	}
	if !control.sawKey("processes.limit") {
		t.Fatal("设置变了没有告诉设备进程是哪个键")
	}
	// 设备进程和运行时都没有被动过：正在跑的终端和连接不受影响。
	if after := deviceFixturePIDs(cfg); len(after) != len(device) || after[0] != device[0] {
		t.Fatalf("改这几项不该重启设备进程: %v → %v", device, after)
	}
	if after := readFixtureEnvironment(t, entries[1]); after.PID != runtimeBefore.PID {
		t.Fatal("改这几项不该重启运行时")
	}
	// 范围之外的值被拒绝，指出是哪一项。
	if _, failure := control.call("settings.write", map[string]any{"expectedVersion": 1, "edits": []settingEdit{edit("processes.limit", 0)}}); failure == nil || failure.Reason != "invalid" || failure.Key != "processes.limit" {
		t.Fatalf("范围之外的值应被拒绝: %+v", failure)
	}
	// 设备进程之后被重新拉起（这里是把它杀掉）的话，启动参数带的是现行值。
	if err := syscall.Kill(device[0], syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "设备进程被重新拉起", func() bool { return len(deviceFixturePIDs(cfg)) == 2 && canDial(cfg.deviceSocket()) })
	if got := strings.Join(deviceFixtureArguments(t, cfg), " "); !strings.Contains(got, "--process-buffer-bytes 2097152 --process-limit 3 --process-idle-ms 120000 --process-exited-ms 600000") {
		t.Fatalf("重新拉起设备进程应带现行值: %s", got)
	}
}

// 假运行时现在的进程号。读不到（正在起、文件正写到一半）返回 0。
func fixturePID(entry configuration) int {
	var environment fixtureEnvironment
	data, err := os.ReadFile(filepath.Join(entry.directory(), "fixture-env.json"))
	if err != nil || json.Unmarshal(data, &environment) != nil {
		return 0
	}
	return environment.PID
}

// 把假运行时杀掉，等它换了一个进程又跑起来，返回新的进程号。
func killAndAwaitRestart(t *testing.T, control *controlClient, entry configuration, what string) int {
	t.Helper()
	before := fixturePID(entry)
	if before == 0 {
		t.Fatalf("%s：读不到假运行时的进程号", what)
	}
	if err := syscall.Kill(before, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	after := 0
	waitUntil(t, what, func() bool {
		state, ok := control.latest()
		after = fixturePID(entry)
		return ok && state.harness(entry.harness).State == stateRunning && after != 0 && after != before && runtimeAnswers(entry)
	})
	return after
}

// 运行时跑起来之后自己停了（这里是被杀掉）会自动再起；连着停、次数用完了就停在“已停止”，等人重新应用。
func TestRuntimeThatStopsOnItsOwnIsRestarted(t *testing.T) {
	delays := autoRestartDelays
	autoRestartDelays = []time.Duration{40 * time.Millisecond, 40 * time.Millisecond}
	t.Cleanup(func() { autoRestartDelays = delays })
	_, entries, control, stop := startManaged(t)
	defer stop()
	claude, pi := entries[0], entries[1]
	control.waitState("两个都在跑", func(state controlState) bool {
		return state.harness("claude-code").State == stateRunning && state.harness("pi").State == stateRunning
	})
	other := fixturePID(claude)

	killAndAwaitRestart(t, control, pi, "第一次自己停了之后又起来")
	// 等着再起的那一会儿报的是“正在起”，原因里说了是自动重启、第几次。
	said := false
	control.mu.Lock()
	for _, state := range control.states {
		view := state.harness("pi")
		if view.State == stateStarting && view.Text != nil && strings.Contains(view.Text.ZH, "自动重启（第 1 次，最多 2 次）") && strings.Contains(view.Text.EN, "attempt 1 of 2") {
			said = true
		}
	}
	control.mu.Unlock()
	if !said {
		t.Fatal("自动重启的时候没有把这件事报出去")
	}
	last := killAndAwaitRestart(t, control, pi, "第二次自己停了之后又起来")

	// 次数用完了：不再试，停在“已停止”，原因里说了试过几次。
	if err := syscall.Kill(last, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	stopped := control.waitState("停在已停止", func(state controlState) bool {
		return state.harness("pi").State == stateStopped
	})
	if text := stopped.harness("pi").Text; text == nil || !strings.Contains(text.ZH, "已经自动重启了 2 次") || !strings.Contains(text.EN, "restarted automatically 2 times") {
		t.Fatalf("次数用完之后的原因不对: %+v", text)
	}
	time.Sleep(200 * time.Millisecond)
	if latest, _ := control.latest(); latest.harness("pi").State != stateStopped || runtimeAnswers(pi) {
		t.Fatal("次数用完之后不该再自己起")
	}
	// 另一个 harness 从头到尾没有被动过。
	if latest, _ := control.latest(); latest.harness("claude-code").State != stateRunning || fixturePID(claude) != other {
		t.Fatal("一个 harness 的运行时停了，不该动到另一个")
	}

	// 人来重新应用：起来了，次数也清零——之后自己停了照样会自动再起。
	if result := control.apply("pi"); result.State != stateRunning || !runtimeAnswers(pi) {
		t.Fatalf("重新应用之后应该起来: %+v", result)
	}
	killAndAwaitRestart(t, control, pi, "重新应用之后自己停了又起来")
}

// 稳稳跑过一阵的运行时，之前自己停过的次数不算数：隔很久才停一次的不会因为攒够了次数就不再起。
func TestAutoRestartCountResetsAfterCalmRun(t *testing.T) {
	delays, calm := autoRestartDelays, autoRestartCalm
	autoRestartDelays, autoRestartCalm = []time.Duration{40 * time.Millisecond}, 0
	t.Cleanup(func() { autoRestartDelays, autoRestartCalm = delays, calm })
	_, entries, control, stop := startManaged(t)
	defer stop()
	pi := entries[1]
	control.waitState("在跑", func(state controlState) bool { return state.harness("pi").State == stateRunning })
	for _, what := range []string{"第一次", "第二次", "第三次"} {
		killAndAwaitRestart(t, control, pi, what+"自己停了之后又起来")
	}
}
