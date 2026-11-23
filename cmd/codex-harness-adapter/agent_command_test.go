package main

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestLocalGitCommandPreservesCredentialRouting(t *testing.T) {
	for _, args := range [][]string{
		{"rev-parse", "--is-inside-work-tree"}, {"status", "--porcelain"},
		{"-c", "alias.status=!git fetch", "status"},
		{"-c", "log.showSignature=false", "-C", "repo with spaces", "rev-parse", "HEAD"},
		{"--git-dir=/repo/.git", "--work-tree=/repo", "status"},
		{"remote", "-v"}, {"remote", "get-url", "origin"},
	} {
		if !localGitCommand(args) {
			t.Errorf("本地内建命令未直达宿主: %q", args)
		}
	}
	for _, command := range []string{"fetch", "push", "clone", "ls-remote", "pull", "submodule", "credential", "alias-name"} {
		for _, prefix := range [][]string{
			nil,
			{"-c", "credential.helper=", "-C", "repo with spaces"},
			{"-c", "alias.alias-name=!git fetch"},
			{"-calias.alias-name=fetch"},
			{"--config-env=credential.helper=HELPER", "--no-pager"},
			{"--git-dir=/repo/.git", "--work-tree=/repo"},
		} {
			args := append(append([]string{}, prefix...), command)
			if localGitCommand(args) {
				t.Errorf("远端命令或别名绕过凭据入口: %q", args)
			}
		}
	}
	for _, args := range [][]string{
		{"remote", "show", "origin"}, {"remote", "prune", "origin"},
		{"remote", "--verbose", "update"}, {"remote", "add", "-f", "origin", "https://example.com/repo"},
	} {
		if localGitCommand(args) {
			t.Errorf("remote 联网操作绕过凭据入口: %q", args)
		}
	}
}

func TestAgentCommandSlotsAreIndependentAndReusable(t *testing.T) {
	commands, credentials := t.TempDir(), t.TempDir()
	var held []*os.File
	t.Cleanup(func() {
		for _, slot := range held {
			_ = slot.Close()
		}
	})
	for range agentCommandSlots {
		slot, err := acquireAgentCommandSlot(commands)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, slot)
	}
	_, err := acquireAgentCommandSlot(commands)
	var exited *exitError
	if !errors.As(err, &exited) || exited.code != 75 ||
		!(strings.Contains(err.Error(), "retry shortly") || strings.Contains(err.Error(), "请稍后重试")) {
		t.Fatalf("满载应立即返回可理解的重试错误和退出码 75: %v", err)
	}
	credential, err := acquireAgentCommandSlot(credentials)
	if err != nil {
		t.Fatalf("命令满载不能阻止凭据助手取得独立席位: %v", err)
	}
	held = append(held, credential)
	_ = held[0].Close()
	slot, err := acquireAgentCommandSlot(commands)
	if err != nil {
		t.Fatalf("释放后不能复用席位: %v", err)
	}
	held = append(held, slot)
}
