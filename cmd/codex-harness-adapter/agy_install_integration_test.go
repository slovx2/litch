//go:build agy_install_integration && !windows

package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// 显式手动运行：go test -tags agy_install_integration ./cmd/codex-harness-adapter -run TestAgyOfficialInstallerIsolated -v
// 实际下载只落入临时 HOME，结束后由测试框架清理；不启动 ACP、不登录、不接触个人凭据。
func TestAgyOfficialInstallerIsolated(t *testing.T) {
	home := t.TempDir()
	env := []string{
		"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "SHELL=/bin/sh",
		"XDG_CONFIG_HOME=" + filepath.Join(home, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, "data"),
	}
	installer := newInstaller(context.Background(), installHooks{source: versionSource{
		environment: func(string) []string { return env },
		configured:  func(string) string { return "" },
	}})
	for attempt := 0; attempt < 2; attempt++ {
		if _, failure := installer.start("agy", installTargetLatest); failure != nil {
			t.Fatal(failure)
		}
		installer.wait()
		job := installer.jobs()[0]
		t.Log(strings.Join(job.Log, "\n"))
		if job.State != installSucceeded || job.Installed == nil {
			t.Fatalf("官方安装失败: %+v", job)
		}
		if attempt == 0 && !strings.Contains(strings.Join(job.Log, "\n"), "checksum verified") {
			t.Fatal("官方安装器未报告下载校验通过")
		}
		t.Logf("实际安装版本 %s，路径 %s", *job.Installed, envValue(withFallbackCLI("agy", env), "CHA_AGY_CLI"))
	}
}
