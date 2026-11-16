package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/slovx2/litch/internal/hostplatform"
	repairscripts "github.com/slovx2/litch/scripts"
	"golang.org/x/sys/windows"
)

// 跟 Codex 的 Windows 数据目录解析保持一致：环境名不分大小写，默认使用 FOLDERID_Profile。
// 有大小写不同且值冲突的变量时拒绝，避免环境重建的顺序差异把修复指向另一份数据。
func codexControlHome(environment []string) (string, error) {
	home, seen := "", false
	for _, entry := range environment {
		name, value, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(name, "CODEX_HOME") {
			continue
		}
		if seen && home != value {
			return "", fmt.Errorf("conflicting CODEX_HOME environment variables")
		}
		home, seen = value, true
	}
	if home == "" {
		profile, err := windows.KnownFolderPath(windows.FOLDERID_Profile, 0)
		if err != nil {
			return "", fmt.Errorf("cannot resolve the Windows profile: %w", err)
		}
		home = filepath.Join(profile, ".codex")
	}
	if !filepath.IsAbs(home) {
		return "", fmt.Errorf("CODEX_HOME must be absolute")
	}
	return home, nil
}

func repairCodexControlDirectory(ctx context.Context, c configuration) error {
	home, err := codexControlHome(c.environment())
	if err != nil {
		return err
	}

	backup := filepath.Join(c.home, "backups", "codex-control-acl")
	// 参数通过环境传递，路径绝不拼进 PowerShell 源码；脚本内没有提权、下载或递归 ACL 操作。
	source := "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); try { & {" + strings.TrimPrefix(repairscripts.CodexControlRepair, "\ufeff") +
		"\n} -CodexHome $env:LITCH_REPAIR_CODEX_HOME -BackupDirectory $env:LITCH_REPAIR_BACKUP -Apply } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
	units := utf16.Encode([]rune(source))
	encoded := make([]byte, len(units)*2)
	for i, unit := range units {
		encoded[i*2], encoded[i*2+1] = byte(unit), byte(unit>>8)
	}
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	// 使用系统自带的 PowerShell，不从用户 PATH 选择修复程序。
	command := exec.CommandContext(runCtx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		"-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(encoded))
	command.Env = append(os.Environ(), "LITCH_REPAIR_CODEX_HOME="+home, "LITCH_REPAIR_BACKUP="+backup)
	hostplatform.Quiet(command)
	output, err := command.CombinedOutput()
	if err != nil {
		if runCtx.Err() != nil {
			return runCtx.Err()
		}
		return fmt.Errorf("%s", strings.TrimSpace(string(output)))
	}
	return nil
}
