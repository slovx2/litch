package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 捕获真实命令输出，防止内部字段、子进程警告或堆栈重新进入用户终端。
func captureTerminal(t *testing.T, action func() error) (string, error) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "terminal-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	stdout, stderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = file, file
	defer func() { os.Stdout, os.Stderr = stdout, stderr }()
	actionErr := action()
	if actionErr != nil {
		fmt.Fprintln(file, actionErr)
	}
	output, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(output), actionErr
}

func assertCleanTerminal(t *testing.T, output string) {
	t.Helper()
	for _, internal := range []string{"releaseReady", "ExperimentalWarning", "cliSha256", "at internal", "pty-self-check ok", "INTERNAL_DETAIL"} {
		if strings.Contains(output, internal) {
			t.Fatalf("用户终端泄漏 %s: %s", internal, output)
		}
	}
}

func TestDoctorShowsResultAndKeepsDetailsInLog(t *testing.T) {
	cfg := testConfiguration(t)
	writeStartFixture(t, cfg)
	fixture := `console.error('ExperimentalWarning: SQLite INTERNAL_DETAIL');
if (process.argv.includes('--runtime-info')) console.log(JSON.stringify({engine:'pi',protocolVersion:'0.163.0',nodeVersion:process.versions.node,releaseReady:false,cliSha256:'INTERNAL_DETAIL'}));
else console.log('pty-self-check ok');`
	if err := os.WriteFile(cfg.adapter(), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := captureTerminal(t, func() error { return doctor(t.Context(), cfg) })
	if err != nil || !strings.Contains(output, "检查通过") {
		t.Fatalf("没有明确成功结论: %s %v", output, err)
	}
	assertCleanTerminal(t, output)
	log, err := os.ReadFile(filepath.Join(cfg.harnessLogDirectory(), "diagnostics.log"))
	if err != nil || !strings.Contains(string(log), "releaseReady") || !strings.Contains(string(log), "ExperimentalWarning") || !strings.Contains(string(log), "pty-self-check ok") {
		t.Fatalf("诊断证据丢失: %s %v", log, err)
	}
}

func TestDiagnosticFailuresRemainActionable(t *testing.T) {
	for _, scenario := range []struct{ name, fixture, message string }{
		{"missing-cli", `console.error('Error: 宿主 CLI 不可执行或未找到: pi\n    at internal INTERNAL_DETAIL'); process.exit(1);`, "没有找到 Pi 的命令行"},
		{"standalone-pi", `console.error('无法从 /opt/pi 定位 Pi 的 npm 包 INTERNAL_DETAIL'); process.exit(1);`, "通过 npm 完整安装的 Pi"},
		{"incompatible-pi", `console.error('用户安装的 Pi 9.0.0 与适配器不兼容（缺少 createEventBus）INTERNAL_DETAIL'); process.exit(1);`, "请升级适配器"},
		{"invalid-response", `console.log('INTERNAL_DETAIL invalid JSON');`, "检查结果无效"},
		{"unexpected-error", `console.error('Error: INTERNAL_DETAIL\n    at internal'); process.exit(1);`, "重新安装和构建"},
		{"old-cli", `console.error('需要用户安装的 Pi CLI >= 0.99.1 INTERNAL_DETAIL'); process.exit(1);`, "最低稳定版本"},
		{"old-dsh", `console.error('宿主 dsh CLI 版本不符: 需要 >= 0.2.0-rc.2，实际 0.1.5 INTERNAL_DETAIL'); process.exit(1);`, "DSH 版本低于"},
		{"broken-dsh", `console.error('无法读取宿主 dsh CLI 版本: /opt/dsh INTERNAL_DETAIL'); process.exit(1);`, "dsh --version"},
		{"old-node", `console.error('INTERNAL_DETAIL'); console.log(JSON.stringify({engine:'pi',protocolVersion:'0.163.0',nodeVersion:'22.23.1'}));`, "Node.js 版本过低"},
		{"sandbox", `console.error('Claude 沙箱依赖不可用: bwrap INTERNAL_DETAIL'); process.exit(1);`, "沙箱依赖不可用"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			cfg := testConfiguration(t)
			writeStartFixture(t, cfg)
			if err := os.WriteFile(cfg.adapter(), []byte(scenario.fixture), 0o600); err != nil {
				t.Fatal(err)
			}
			output, err := captureTerminal(t, func() error { return doctor(t.Context(), cfg) })
			if err == nil || !strings.Contains(output, scenario.message) || !strings.Contains(output, "diagnostics.log") {
				t.Fatalf("缺少失败原因或排障路径: %s %v", output, err)
			}
			assertCleanTerminal(t, output)
			log, err := os.ReadFile(filepath.Join(cfg.harnessLogDirectory(), "diagnostics.log"))
			if err != nil || !strings.Contains(string(log), "INTERNAL_DETAIL") {
				t.Fatalf("失败证据丢失: %s %v", log, err)
			}
		})
	}
}

// 找不到命令行时的原因：只提这个 harness 自己的那个环境变量，并说明设备的设置里也能填路径。
// 路径已经在设置里或者环境变量里给了、只是给得不对的，说的是那一处该改。
func TestMissingCLINamesOnlyItsOwnVariable(t *testing.T) {
	missing := func(t *testing.T, cfg configuration) bilingual {
		t.Helper()
		writeStartFixture(t, cfg)
		fixture := `console.error('Error: 宿主 CLI 不可执行或未找到: nowhere INTERNAL_DETAIL'); process.exit(1);`
		if err := os.WriteFile(cfg.adapter(), []byte(fixture), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := inspectRuntime(t.Context(), cfg)
		var failure *harnessFailure
		if !errors.As(err, &failure) || failure.kind != stateNotInstalled {
			t.Fatalf("找不到命令行应报没装: %v", err)
		}
		return failure.text
	}
	for id, variable := range harnessCLIVariable {
		t.Run(id, func(t *testing.T) {
			t.Setenv(variable, "")
			cfg := settingsTestConfiguration(t)
			text := missing(t, cfg.forHarness(id))
			for _, said := range []string{text.ZH, text.EN} {
				for _, expected := range []string{harnessNames[id], variable, cliPathKey(id)} {
					if !strings.Contains(said, expected) {
						t.Fatalf("原因里应提到 %s: %s", expected, said)
					}
				}
				for other, foreign := range harnessCLIVariable {
					if other != id && strings.Contains(said, foreign) {
						t.Fatalf("%s 的原因里不该提别的 harness 的变量 %s: %s", id, foreign, said)
					}
				}
			}
			// 环境变量里给了路径：说的是这个变量指错了。
			t.Setenv(variable, filepath.Join(cfg.home, "no-such-cli"))
			if text := missing(t, cfg.forHarness(id)); !strings.Contains(text.ZH, "环境变量 "+variable+" 指的") || !strings.Contains(text.EN, variable) {
				t.Fatalf("环境变量指错了应明说: %+v", text)
			}
			// 设置里填了路径：说的是设置里那一项该改，它盖过环境变量。
			if _, problem, err := cfg.settings.apply(0, []settingEdit{edit(cliPathKey(id), filepath.Join(cfg.home, "no-such-cli"))}, buildSettingsSchema(cfg), nil); err != nil || problem != nil {
				t.Fatalf("写入失败: %+v %v", problem, err)
			}
			if text := missing(t, cfg.forHarness(id)); !strings.Contains(text.ZH, "设置里") || strings.Contains(text.ZH, variable) || !strings.Contains(text.EN, cliPathKey(id)) {
				t.Fatalf("设置里的路径不对应明说: %+v", text)
			}
		})
	}
}

func TestStartKeepsRuntimeOutputInLog(t *testing.T) {
	for _, crash := range []bool{false, true} {
		t.Run(fmt.Sprint(crash), func(t *testing.T) {
			cfg := testConfiguration(t)
			writeStartFixture(t, cfg)
			fixture, err := os.ReadFile(cfg.adapter())
			if err != nil {
				t.Fatal(err)
			}
			prefix := `console.error('ExperimentalWarning: SQLite INTERNAL_DETAIL');
if (!process.argv.includes('--runtime-info')) { console.log('INTERNAL_DETAIL stdout'); console.error('INTERNAL_DETAIL stderr');`
			if crash {
				prefix += `process.exit(1);`
			}
			prefix += "}\n"
			if err := os.WriteFile(cfg.adapter(), append([]byte(prefix), fixture...), 0o600); err != nil {
				t.Fatal(err)
			}
			output, startErr := captureTerminal(t, func() error {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if crash {
					return start(ctx, cfg)
				}
				done := make(chan error, 1)
				go func() { done <- start(ctx, cfg) }()
				waitStartedHarness(t, cfg, done)
				cancel()
				return <-done
			})
			if crash && (startErr == nil || !strings.Contains(output, "引擎启动失败") || !strings.Contains(output, "runtime.log")) {
				t.Fatalf("运行失败被隐藏: %s %v", output, startErr)
			}
			if !crash && (startErr != nil || !strings.Contains(output, "SSH 就绪")) {
				t.Fatalf("入口未启动: %s %v", output, startErr)
			}
			assertCleanTerminal(t, output)
			log, err := os.ReadFile(filepath.Join(cfg.harnessLogDirectory(), "runtime.log"))
			if err != nil || !strings.Contains(string(log), "INTERNAL_DETAIL stderr") || !strings.Contains(string(log), "INTERNAL_DETAIL stdout") {
				t.Fatalf("运行日志丢失: %s %v", log, err)
			}
		})
	}
}
