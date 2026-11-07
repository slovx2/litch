//go:build !windows

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAgyInstallLatestWithoutVersionRegistry(t *testing.T) {
	rig := newInstallRig(t, "http://127.0.0.1:1/registry-must-not-be-used")
	writeScript(t, filepath.Join(rig.tools, "curl"), `
[ "$*" = '-fsSL https://antigravity.google/cli/install.sh' ] || exit 9
cat <<'INSTALL'
[ "$#" = 0 ] || exit 8
if [ -f "$HOME/.local/bin/agy" ]; then echo 'already installed'; exit 0; fi
echo 'checksum verified (fixture)'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho "Antigravity CLI 1.4.12"\n' > "$HOME/.local/bin/agy"
chmod +x "$HOME/.local/bin/agy"
INSTALL
`)
	for attempt := 0; attempt < 2; attempt++ {
		job := rig.finished(t, rig.start(t, "agy", installTargetLatest))
		if job.State != installSucceeded || job.Installed == nil || *job.Installed != "1.4.12" || job.Resolved == nil || *job.Resolved != "1.4.12" {
			t.Fatalf("首次安装与脚本已有文件退出都应报告实际版本: %+v", job)
		}
		if attempt == 1 && !strings.Contains(strings.Join(job.Log, "\n"), "already installed") {
			t.Fatal("应保留官方脚本已有安装的输出")
		}
	}
	if len(rig.found) != 2 || rig.found[0].path != filepath.Join(rig.home, ".local", "bin", "agy") {
		t.Fatal("安装结果应交给设备端的启用/重启回调")
	}
}

func TestAgyInstallDownloadFailureIsVisible(t *testing.T) {
	rig := newInstallRig(t, "http://127.0.0.1:1/registry-must-not-be-used")
	writeScript(t, filepath.Join(rig.tools, "curl"), "echo 'download failed (fixture)' >&2\nexit 22\n")
	job := rig.finished(t, rig.start(t, "agy", installTargetLatest))
	if job.State != installFailed || job.Failure == nil || !strings.Contains(strings.Join(job.Log, "\n"), "download failed") || len(rig.found) != 0 {
		t.Fatalf("下载失败应保留原因与日志，不能启用未安装的 CLI: %+v", job)
	}
}
