//go:build !windows

package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// 全部 CLI 都是假脚本，HOME/PATH 只指临时目录，不读取真实 Google 登录数据。
func TestAgyDetectCLIAndForwardSubscriptionPath(t *testing.T) {
	root := t.TempDir()
	home, bin := filepath.Join(root, "home"), filepath.Join(root, "bin")
	env := []string{"HOME=" + home, "PATH=" + bin}
	source := versionSource{
		environment: func(string) []string { return env },
		configured:  func(string) string { return envValue(env, "CHA_AGY_CLI") },
	}
	cache := newVersionCache()
	check := func(path, version string) {
		t.Helper()
		info := cache.info(context.Background(), source, "agy", true)
		if path == "" {
			if info.Installed != nil || len(info.Candidates) != 0 {
				t.Fatalf("仅 App/IDE 不能算 CLI 已安装: %+v", info)
			}
			return
		}
		if info.Installed == nil || *info.Installed != version {
			t.Fatalf("版本应为 %s: %+v", version, info)
		}
		forwarded := withFallbackCLI("agy", env)
		if got := envValue(forwarded, "CHA_AGY_CLI"); got != path {
			t.Fatalf("订阅应收到已选择的 CLI %s，实际 %s", path, got)
		}
		if got := envValue(forwarded, "CHA_ANTIGRAVITY_CLI"); got != envValue(env, "CHA_ANTIGRAVITY_CLI") {
			t.Fatalf("订阅检测不能改写 SDK runtime: %s", got)
		}
	}
	writeScript(t, filepath.Join(bin, "antigravity-ide"), "echo 'Antigravity IDE 2.6.0'\n")
	writeScript(t, filepath.Join(home, "Applications", "Antigravity.app", "Contents", "MacOS", "Antigravity"), "echo '2.29.0'\n")
	check("", "")
	// 官方默认目录不在 PATH，仍能探测并交给 ACP 后端。
	official := filepath.Join(home, ".local", "bin", "agy")
	writeScript(t, official, "echo 'Antigravity CLI 1.4.12'\n")
	check(official, "1.4.12")
	pathCLI := filepath.Join(bin, "agy")
	writeScript(t, pathCLI, "echo 'Antigravity CLI 1.4.13'\n")
	check(pathCLI, "1.4.13")
	// 显式路径优先于较新的自动发现项；SDK 路径独立保留。
	explicit := filepath.Join(root, "custom", "agy")
	writeScript(t, explicit, "echo 'Antigravity CLI 1.4.11'\n")
	env = append(env, "CHA_AGY_CLI="+explicit, "CHA_ANTIGRAVITY_CLI=/sdk/localharness")
	check(explicit, "1.4.11")
	env = append(env, "CHA_AGY_CLI="+filepath.Join(root, "missing"))
	if info := cache.info(context.Background(), source, "agy", false); info.Installed != nil {
		t.Fatal("无效显式路径不能悄悄换成另一份 CLI")
	}
}

func TestAgyOfficialInstallationMetadata(t *testing.T) {
	saved := installGOOS
	t.Cleanup(func() { installGOOS = saved })
	for _, system := range []string{"darwin", "linux", "windows"} {
		installGOOS = system
		root := t.TempDir()
		source := versionSource{
			environment: func(string) []string { return []string{"HOME=" + root, "PATH=" + root} },
			configured:  func(string) string { return "" },
		}
		info := newVersionCache().info(context.Background(), source, "agy", true)
		want := "curl -fsSL https://antigravity.google/cli/install.sh | bash"
		if system == "windows" {
			want = "& ([scriptblock]::Create((irm https://antigravity.google/cli/install.ps1)))"
		}
		if info.Manual != want || info.DocsURL != "https://antigravity.google/docs/getting-started" || !info.Installable || info.LatestError != nil || info.Latest != nil || info.Verified != nil {
			t.Fatalf("应提供官方命令且不请求 npm 版本或冒充按版本安装: %+v", info)
		}
		installer := newInstaller(context.Background(), installHooks{source: source})
		if _, failure := installer.start("agy", installTargetVerified); failure == nil {
			t.Fatal("官方安装器没有版本选择，不能伪造验证版安装")
		}
	}
	installGOOS = "windows"
	paths := cliFallbackPaths(specOf("agy"), []string{"USERPROFILE=/users/test", "LOCALAPPDATA=/custom/local"})
	if len(paths) != 1 || paths[0] != filepath.Join("/custom/local", "agy", "bin", "agy") {
		t.Fatal(paths)
	}
	paths = cliFallbackPaths(specOf("agy"), []string{"USERPROFILE=/users/test"})
	if len(paths) != 1 || paths[0] != filepath.Join("/users/test", "AppData", "Local", "agy", "bin", "agy") {
		t.Fatal(paths)
	}
}

func TestAgyDisabledIsSeparateFromInstalledAndSDK(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("PATH", root)
	t.Setenv("CHA_AGY_CLI", "")
	t.Setenv("CHA_ANTIGRAVITY_CLI", "")
	cfg := settingsTestConfiguration(t)
	manager := newHarnessManager(cfg)
	assertDisabled := func() {
		t.Helper()
		if enabled, state, _ := manager.wanted("agy"); enabled || state != stateDisabled {
			t.Fatalf("默认停用不是未安装: %v %s", enabled, state)
		}
	}
	assertDisabled()
	cli := filepath.Join(root, ".local", "bin", "agy")
	writeScript(t, cli, "echo '1.4.12'\n")
	assertDisabled()
	_, problem, err := cfg.settings.apply(0, []settingEdit{
		edit(cliPathKey("agy"), cli),
		edit(enabledKey("agy"), true),
		edit(envKey("agy"), []envEntry{{Name: "CHA_ANTIGRAVITY_CLI", Value: optional("/custom/sdk")}}),
	}, manager.settingsSchema(), nil)
	if err != nil || problem != nil {
		t.Fatalf("%v %v", err, problem)
	}
	env := cfg.forHarness("agy").environment()
	if envValue(env, "CHA_AGY_CLI") != cli || envValue(env, "CHA_ANTIGRAVITY_CLI") != "/custom/sdk" {
		t.Fatal("设备命令行路径必须控制订阅 CLI，不能覆盖 SDK 路径")
	}
	if enabled, _, _ := manager.wanted("agy"); !enabled {
		t.Fatal("显式启用应运行")
	}
	texts := harnessSettingTexts("agy")
	if texts.group == nil || !strings.Contains(texts.group.ZH, "默认停用") || !strings.Contains(texts.cliPath.EN, "CHA_AGY_CLI") {
		t.Fatal("详情设置应说明停用和订阅 CLI 的路径")
	}
}
