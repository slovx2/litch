//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 假的 codex 命令行：`--version` 报给定的版本；`app-server --listen unix://PATH` 在那个套接字上监听，
// 把收到的命令行、环境和自己的进程号记在套接字旁边。别的用法一律报错退出。
// 用例只让服务去跑它，不会碰到这台机器上真的 codex：要么在设置里写明它的路径，要么把 PATH 换成只有它的目录。
func writeFakeCodex(t *testing.T, cfg configuration, version string) string {
	t.Helper()
	node, err := exec.LookPath(cfg.node)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(cfg.home, "fake-codex-"+version)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	fixture := fmt.Sprintf(`import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('codex-cli ' + %q);
} else if (args.length === 3 && args[0] === 'app-server' && args[1] === '--listen' && args[2].startsWith('unix://')) {
  const socket = args[2].slice(7);
  console.error('fake codex app-server started');
  fs.writeFileSync(path.join(path.dirname(socket), 'fixture-env.json'), JSON.stringify({
    mark: process.env.FIXTURE_MARK ?? null, pid: process.pid, args, cwd: process.cwd(),
    codexHome: process.env.CODEX_HOME ?? null,
  }));
  net.createServer(c=>{c.on('error',()=>{});c.end('runtime-proxy')}).listen(socket);
} else {
  console.error('unexpected arguments: ' + JSON.stringify(args));
  process.exit(2);
}
`, version)
	script := filepath.Join(directory, "fixture.mjs")
	if err := os.WriteFile(script, []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(directory, "codex")
	if err := os.WriteFile(launcher, []byte(fmt.Sprintf("#!/bin/sh\nexec %q %q \"$@\"\n", node, script)), 0o700); err != nil {
		t.Fatal(err)
	}
	return launcher
}

type codexFixtureRecord struct {
	Mark      *string  `json:"mark"`
	PID       int      `json:"pid"`
	Args      []string `json:"args"`
	Cwd       string   `json:"cwd"`
	CodexHome *string  `json:"codexHome"`
}

func readCodexFixture(t *testing.T, entry configuration) codexFixtureRecord {
	t.Helper()
	var record codexFixtureRecord
	data, err := os.ReadFile(filepath.Join(entry.directory(), "fixture-env.json"))
	if err != nil || json.Unmarshal(data, &record) != nil {
		t.Fatalf("假的 codex 没有留下记录: %v", err)
	}
	return record
}

type diagnosticsReply struct {
	Checks []struct {
		ID     string       `json:"id"`
		Scope  settingScope `json:"scope"`
		Status string       `json:"status"`
		Detail *bilingual   `json:"detail"`
	} `json:"checks"`
}

// 原生 codex 和另外三个一样受管：没装（用例里一律按没装）、没写过设置时什么都不起；在设置里打开就照设置找命令行、看版本、起 app-server；
// 没装、版本过低如实报；运行中关掉再打开；诊断和日志都有它；没有 SSH 入口。
func TestControlManagesNativeCodex(t *testing.T) {
	cfg, _, control, stop := startManaged(t)
	defer stop()
	codex := cfg.forHarness(nativeCodex)
	first := control.waitState("收到完整的状态", func(state controlState) bool {
		return state.harness("pi").State == stateRunning && state.harness(nativeCodex).State == stateNotInstalled
	})
	view := first.harness(nativeCodex)
	if !view.Native || view.Socket != "unix://"+codex.socket() || view.Text == nil || view.Text.EN == "" {
		t.Fatalf("原生 codex 起始的状态不对: %+v", view)
	}
	if _, err := os.Stat(codex.directory()); !os.IsNotExist(err) {
		t.Fatal("没启用时不该为原生 codex 建任何东西")
	}
	if len(first.Snapshot.SSHEntries) != len(adapterHarnesses) || first.Snapshot.sshEntry(nativeCodex).Harness != "" {
		t.Fatalf("原生 codex 没有 SSH 入口: %+v", first.Snapshot.SSHEntries)
	}
	if arguments := strings.Join(deviceFixtureArguments(t, cfg), " "); strings.Contains(arguments, "codex=") {
		t.Fatalf("原生 codex 不走设备进程的启动参数: %s", arguments)
	}
	var diagnosis diagnosticsReply
	control.must("diagnostics.run", map[string]any{"harness": nativeCodex}, &diagnosis)
	if len(diagnosis.Checks) != 1 || diagnosis.Checks[0].Status != "skipped" || diagnosis.Checks[0].Detail == nil {
		t.Fatalf("没启用时诊断里它应记成跳过: %+v", diagnosis.Checks)
	}

	// 打开：照设置里的路径找命令行，命令行和环境都照定好的来。
	good := writeFakeCodex(t, cfg, "0.160.0")
	dataHome := filepath.Join(cfg.home, "fake-codex-data")
	environment := func(mark string) settingEdit {
		return edit(envKey(nativeCodex), []map[string]any{{"name": "FIXTURE_MARK", "value": mark}, {"name": "CODEX_HOME", "value": dataHome}})
	}
	snapshot := control.write(0, edit(enabledKey(nativeCodex), true), edit(cliPathKey(nativeCodex), good), environment("one"))
	if !snapshot.pending(nativeCodex) || canDial(codex.socket()) {
		t.Fatalf("写入只是记下来，要重新应用才起: %+v", snapshot.PendingRestart)
	}
	result := control.apply(nativeCodex)
	if result.State != stateRunning || result.Text != nil || result.Snapshot.pending(nativeCodex) {
		t.Fatalf("启用之后没有起来: %+v", result)
	}
	started := readCodexFixture(t, codex)
	if want := []string{"app-server", "--listen", "unix://" + filepath.Join(cfg.home, "codex", "runtime.sock")}; strings.Join(started.Args, "\n") != strings.Join(want, "\n") {
		t.Fatalf("起 app-server 的命令行不对:\n得到 %q\n应为 %q", started.Args, want)
	}
	home, _ := os.UserHomeDir()
	wantCwd, _ := filepath.EvalSymlinks(home)
	if gotCwd, _ := filepath.EvalSymlinks(started.Cwd); gotCwd != wantCwd {
		t.Fatalf("app-server 的工作目录应是用户主目录 %s，得到 %s", wantCwd, started.Cwd)
	}
	if !runtimeAnswers(codex) || started.Mark == nil || *started.Mark != "one" || started.CodexHome == nil || *started.CodexHome != dataHome {
		t.Fatalf("app-server 没有带上设置里的环境变量: %+v", started)
	}
	running := control.waitState("状态里是在运行", func(state controlState) bool {
		return state.harness(nativeCodex).State == stateRunning
	})
	if running.harness(nativeCodex).Text != nil || len(running.Snapshot.SSHEntries) != len(adapterHarnesses) {
		t.Fatalf("在运行时的状态不对: %+v", running.harness(nativeCodex))
	}
	if _, err := os.Stat(filepath.Join(codex.directory(), "identity")); !os.IsNotExist(err) {
		t.Fatal("原生 codex 没有 SSH 入口，不该有入口的身份文件")
	}
	// 它的进程号记在状态目录里：服务被强杀的话，下次靠它把留下的 app-server 收掉。
	if recorded, _ := os.ReadFile(codexPidPath(codex)); string(recorded) != strconv.Itoa(started.PID) {
		t.Fatalf("记下的进程号不对: %q，应为 %d", recorded, started.PID)
	}

	// 诊断里有它那一项，没有 SSH 入口那一项；两种日志都读得到。
	control.must("diagnostics.run", map[string]any{"harness": nativeCodex}, &diagnosis)
	if len(diagnosis.Checks) != 1 || diagnosis.Checks[0].ID != "runtime" || diagnosis.Checks[0].Status != "ok" || diagnosis.Checks[0].Scope != harnessScope(nativeCodex) {
		t.Fatalf("诊断的结果不对: %+v", diagnosis.Checks)
	}
	for source, want := range map[string]string{"runtime": "fake codex app-server started", "diagnostics": "codex --version"} {
		var tail struct {
			Text string `json:"text"`
		}
		control.must("logs.tail", map[string]any{"source": source, "harness": nativeCodex}, &tail)
		if !strings.Contains(tail.Text, want) {
			t.Fatalf("%s 日志里应有 %q:\n%s", source, want, tail.Text)
		}
	}
	var config struct {
		Entries []sshConfigEntry `json:"entries"`
	}
	control.must("ssh.config", nil, &config)
	for _, entry := range config.Entries {
		if entry.Harness == nativeCodex {
			t.Fatalf("ssh 配置里不该有原生 codex: %+v", config.Entries)
		}
	}

	// 改环境变量后重启：换了一个进程，新的值生效。
	control.write(1, environment("two"))
	if current := readCodexFixture(t, codex); current.PID != started.PID {
		t.Fatal("改了环境变量不该擅自重启")
	}
	if result = control.apply(nativeCodex); result.State != stateRunning {
		t.Fatalf("重启没有成功: %+v", result)
	}
	restarted := readCodexFixture(t, codex)
	if restarted.Mark == nil || *restarted.Mark != "two" || restarted.PID == started.PID || processAlive(started.PID) {
		t.Fatalf("重启之后应换了进程、环境变量生效: %+v", restarted)
	}

	// 版本低于下限：不起，报版本过低，说出两个版本号。
	control.write(2, edit(cliPathKey(nativeCodex), writeFakeCodex(t, cfg, "0.149.0")))
	result = control.apply(nativeCodex)
	if result.State != stateVersionTooLow || result.Text == nil || !strings.Contains(result.Text.ZH, "0.149.0") || !strings.Contains(result.Text.EN, minimumCodexVersion) {
		t.Fatalf("版本过低时应如实报: %+v", result)
	}
	if canDial(codex.socket()) || processAlive(restarted.PID) {
		t.Fatal("版本过低时不该有 app-server 在跑")
	}
	// 更高版本的预发布版可以用。
	control.write(3, edit(cliPathKey(nativeCodex), writeFakeCodex(t, cfg, "0.162.0-alpha.20")))
	if result = control.apply(nativeCodex); result.State != stateRunning {
		t.Fatalf("更高版本的预发布版应该能用: %+v", result)
	}

	// 路径指到不存在的地方：没装。清掉路径后在 PATH 里找：找不到是没装，找得到就起来。
	control.write(4, edit(cliPathKey(nativeCodex), filepath.Join(cfg.home, "no-such-codex")))
	if result = control.apply(nativeCodex); result.State != stateNotInstalled || result.Text == nil || !strings.Contains(result.Text.ZH, "路径") {
		t.Fatalf("路径不对时应报没装: %+v", result)
	}
	empty := filepath.Join(cfg.home, "empty-bin")
	if err := os.MkdirAll(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	searchPath := func(directory string) settingEdit {
		return edit(envKey(nativeCodex), []map[string]any{{"name": "PATH", "value": directory}})
	}
	control.write(5, settingEdit{Key: cliPathKey(nativeCodex), Value: json.RawMessage("null")}, searchPath(empty))
	if result = control.apply(nativeCodex); result.State != stateNotInstalled || result.Text == nil || !strings.Contains(result.Text.ZH, "没有找到 Codex 的命令行") || !strings.Contains(result.Text.EN, cliPathKey(nativeCodex)) {
		t.Fatalf("PATH 里没有 codex 时应报没装: %+v", result)
	}
	control.must("diagnostics.run", map[string]any{"harness": nativeCodex}, &diagnosis)
	if len(diagnosis.Checks) != 1 || diagnosis.Checks[0].Status != "failed" || diagnosis.Checks[0].Detail == nil {
		t.Fatalf("启用了却没装，诊断应记成没通过: %+v", diagnosis.Checks)
	}
	control.write(6, searchPath(filepath.Dir(good)))
	if result = control.apply(nativeCodex); result.State != stateRunning {
		t.Fatalf("PATH 里有 codex 时应该起来: %+v", result)
	}
	onPath := readCodexFixture(t, codex)

	// 运行中关掉：进程收掉，状态是已停用；再打开又起来。别的 harness 不受连累。
	control.write(7, edit(enabledKey(nativeCodex), false))
	if result = control.apply(nativeCodex); result.State != stateDisabled || result.Text == nil {
		t.Fatalf("停用之后的状态不对: %+v", result)
	}
	if canDial(codex.socket()) || processAlive(onPath.PID) {
		t.Fatal("停用之后 app-server 还在")
	}
	if _, err := os.Stat(codexPidPath(codex)); !os.IsNotExist(err) {
		t.Fatal("正常收掉之后记着的进程号应该抹掉")
	}
	control.write(8, edit(enabledKey(nativeCodex), true))
	if result = control.apply(nativeCodex); result.State != stateRunning || !runtimeAnswers(codex) {
		t.Fatalf("再打开之后没有起来: %+v", result)
	}
	last := readCodexFixture(t, codex)
	if state, _ := control.latest(); state.harness("pi").State != stateRunning || state.harness("claude-code").State != stateRunning {
		t.Fatalf("开关原生 codex 连累了别的 harness: %+v", state.Harnesses)
	}

	// 服务停了，它起的 app-server 一并收掉。
	stop()
	if processAlive(last.PID) || canDial(codex.socket()) {
		t.Fatal("服务停了之后 app-server 还在")
	}
}

// 上一次的服务被强杀时留下的 app-server：下次起之前按记下的进程号收掉；
// 记着的进程号已经是别的进程的了，不动它。
// 没写过设置时原生 codex 照装没装定：现行环境的 PATH 里有可执行的 codex 才算装了（同名的不可执行文件不算），
// 设置里填了命令行路径就算要用它（路径不对，启动时再说）。
func TestCodexDefaultFollowsInstallation(t *testing.T) {
	codexInstalled = detectCodex
	t.Cleanup(func() { codexInstalled = func(configuration) bool { return false } })
	empty, installed := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(installed, "codex"), []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(empty, "codex"), []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := settingsTestConfiguration(t)
	t.Setenv("PATH", empty)
	if cfg.defaultEnabled(nativeCodex) {
		t.Fatal("PATH 里只有不可执行的同名文件，不算装了 codex")
	}
	t.Setenv("PATH", empty+string(os.PathListSeparator)+installed)
	if !cfg.defaultEnabled(nativeCodex) {
		t.Fatal("PATH 里有 codex 时应默认启用")
	}
	t.Setenv("PATH", empty)
	missing := filepath.Join(empty, "missing")
	if _, problem, err := cfg.settings.apply(0, []settingEdit{edit(cliPathKey(nativeCodex), missing)}, buildSettingsSchema(cfg), cfg.validateSettings); err != nil || problem != nil {
		t.Fatalf("写入失败: %+v %v", problem, err)
	}
	if !cfg.defaultEnabled(nativeCodex) {
		t.Fatal("设置里填了命令行路径就算要用它")
	}
}

func TestCodexOrphanIsReaped(t *testing.T) {
	cfg := testConfiguration(t)
	codex := cfg.forHarness(nativeCodex)
	if err := os.MkdirAll(codex.directory(), 0o700); err != nil {
		t.Fatal(err)
	}
	launch := func(name string, args ...string) (*exec.Cmd, <-chan struct{}) {
		t.Helper()
		process := exec.Command(name, args...)
		hostplatform.Prepare(process)
		if err := process.Start(); err != nil {
			t.Fatal(err)
		}
		exited := make(chan struct{})
		go func() { _ = process.Wait(); close(exited) }()
		t.Cleanup(func() { _ = hostplatform.Kill(process); <-exited })
		return process, exited
	}
	orphan, orphanExited := launch(writeFakeCodex(t, cfg, "0.160.0"), "app-server", "--listen", hostplatform.ListenURL(codex.socket()))
	waitUntil(t, "留下的 app-server 在听", func() bool { return canDial(codex.socket()) })
	recordCodexProcess(codex, orphan.Process.Pid)
	reapCodexOrphan(codex)
	select {
	case <-orphanExited:
	case <-time.After(5 * time.Second):
		t.Fatal("留下的 app-server 没有被收掉")
	}
	if _, err := os.Stat(codexPidPath(codex)); !os.IsNotExist(err) {
		t.Fatal("收掉之后记着的进程号应该抹掉")
	}

	bystander, bystanderExited := launch("sleep", "30")
	recordCodexProcess(codex, bystander.Process.Pid)
	sweepCodexOrphan(codex)
	select {
	case <-bystanderExited:
		t.Fatal("记着的进程号已经是别的进程的了，不该动它")
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := os.Stat(codexPidPath(codex)); !os.IsNotExist(err) {
		t.Fatal("对不上的进程号也应该抹掉")
	}
}
