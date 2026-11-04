//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 即使已经把自动选出的入口传给引擎，引擎报找不到时也不能责怪用户配置了环境变量。
func TestMissingCLIDoesNotBlameAutomaticSelection(t *testing.T) {
	for _, id := range []string{"claude-code", "pi", "dsh", "opencode", "gemini", "qwen"} {
		locations := []string{"path"}
		if id == "claude-code" {
			locations = append(locations, "default")
		}
		if id == "pi" {
			locations = append(locations, "npm")
		}
		for _, location := range locations {
			t.Run(id+"/"+location, func(t *testing.T) {
				cfg := settingsTestConfiguration(t).forHarness(id)
				spec := specOf(id)
				root := t.TempDir()
				bin := filepath.Join(root, "bin")
				cli := filepath.Join(bin, spec.install.commands[0])
				switch location {
				case "default":
					cli = filepath.Join(root, spec.fallbacks[0])
				case "npm":
					prefix := filepath.Join(root, "npm-global")
					writeScript(t, filepath.Join(bin, "npm"), "echo '"+prefix+"'\n")
					cli = filepath.Join(prefix, "bin", spec.install.commands[0])
				}
				writeScript(t, cli, "echo 9.0.0\n")
				cfg.settingsEnv = map[string]string{"PATH": bin, "HOME": root, spec.cliVariable: " "}
				if got := cfg.environmentValue(spec.cliVariable); got != cli {
					t.Fatalf("夹具必须实际走过自动选择并注入入口：%q != %q", got, cli)
				}
				writeStartFixture(t, cfg)
				fixture := "console.error('宿主 CLI 不可执行或未找到: selected'); process.exit(1);"
				if err := os.WriteFile(cfg.adapter(), []byte(fixture), 0o600); err != nil {
					t.Fatal(err)
				}
				_, err := inspectRuntime(t.Context(), cfg)
				var failure *harnessFailure
				if !errors.As(err, &failure) || failure.kind != stateNotInstalled {
					t.Fatalf("应保留找不到命令行的诊断：%v", err)
				}
				if !strings.HasPrefix(failure.text.ZH, "没有找到 "+harnessNames[id]+" 的命令行") ||
					!strings.HasPrefix(failure.text.EN, "The "+harnessNames[id]+" command-line tool was not found.") {
					t.Fatalf("自动选择不能冒充用户配置：%+v", failure.text)
				}
			})
		}
	}
}

func TestMissingCLIRecognizesUserEnvironmentSources(t *testing.T) {
	for _, source := range []string{"process", "file", "settings"} {
		t.Run(source, func(t *testing.T) {
			cfg := settingsTestConfiguration(t).forHarness("pi")
			t.Setenv("PI_CLI", "")
			if err := os.Unsetenv("PI_CLI"); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "missing")
			switch source {
			case "process":
				t.Setenv("PI_CLI", path)
			case "file":
				cfg.userEnv = map[string]string{"PI_CLI": path}
			case "settings":
				cfg.settingsEnv["PI_CLI"] = path
			}
			text := cliMissing(cfg)
			if !strings.HasPrefix(text.ZH, "环境变量 PI_CLI 指的") || !strings.HasPrefix(text.EN, "The PI_CLI environment variable") {
				t.Fatalf("用户显式提供的变量仍应指出来源：%+v", text)
			}
		})
	}
}
