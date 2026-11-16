package main

import (
	"runtime"
	"strings"
)

const codexControlPermissions = "codexControlPermissions"
const codexPrivateDirectoryError = "socket directory is not private to the current user"

// 只把本轮白名单诊断对应的动作交给客户端，不从客户端接收任意路径或命令。
func codexControlRepairAction(platform, id, state string, text *bilingual) string {
	if platform == "windows" && id == nativeCodex && state == stateStartFailed && text != nil &&
		strings.HasSuffix(text.EN, ": "+codexPrivateDirectoryError) {
		return codexControlPermissions
	}
	return ""
}

func (s *controlServer) repairCodexControl(id, repair string) *controlError {
	state, text, _ := s.manager.status(nativeCodex)
	if repair != codexControlPermissions || codexControlRepairAction(runtime.GOOS, id, state, text) == "" {
		return &controlError{Reason: "invalid", Harness: id, Text: both(
			"当前失败状态不支持此权限修复；请重新检查 Codex 状态", "This permission repair is unavailable for the current failure; check Codex again")}
	}
	for _, pending := range s.manager.pendingRestart() {
		if pending == nativeCodex {
			return &controlError{Reason: "invalid", Harness: id, Text: both(
				"Codex 设置已更改，请先重启以确认当前失败原因", "Codex settings changed; restart it first to confirm the current failure")}
		}
	}
	if err := repairCodexControlDirectory(s.ctx, s.c.forHarness(nativeCodex)); err != nil {
		return &controlError{Reason: "failed", Harness: id, Text: both(
			"Codex 权限修复未完成：%s", "Codex permission repair did not complete: %s").with(err.Error())}
	}
	return nil
}
