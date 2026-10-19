//go:build !windows

package main

// 官方装法放在 PATH 以外的命令行（Claude 的 ~/.local/bin）：组装给引擎的环境时补上命令行变量，
// 已经给了的、PATH 里有的不动。全在临时目录里，不碰本机真的 ~/.local/bin。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envLookup(env []string, name string) (string, int) {
	value, count := "", 0
	for _, entry := range env {
		if key, rest, _ := strings.Cut(entry, "="); key == name {
			value = rest
			count++
		}
	}
	return value, count
}

func TestWithFallbackCLI(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	bin := filepath.Join(root, "bin")
	official := filepath.Join(home, ".local", "bin", "claude")
	writeScript(t, official, "echo '2.1.282 (Claude Code)'\n")

	t.Run("PATH 里没有：补上固定位置", func(t *testing.T) {
		env := withFallbackCLI("claude-code", []string{"PATH=" + bin + ":/usr/bin", "HOME=" + home, "CHA_CLAUDE_CLI="})
		if value, count := envLookup(env, "CHA_CLAUDE_CLI"); value != official || count != 1 {
			t.Fatalf("应补成 %s 且只有一条: %q（%d 条）", official, value, count)
		}
	})
	t.Run("已经给了：不动", func(t *testing.T) {
		env := withFallbackCLI("claude-code", []string{"PATH=" + bin, "HOME=" + home, "CHA_CLAUDE_CLI=/opt/claude"})
		if value, _ := envLookup(env, "CHA_CLAUDE_CLI"); value != "/opt/claude" {
			t.Fatalf("给了的不该换: %q", value)
		}
	})
	t.Run("PATH 里有：不补，引擎自己在 PATH 里找", func(t *testing.T) {
		writeScript(t, filepath.Join(bin, "claude"), "echo '2.1.290 (Claude Code)'\n")
		defer func() { _ = os.Remove(filepath.Join(bin, "claude")) }()
		env := withFallbackCLI("claude-code", []string{"PATH=" + bin, "HOME=" + home})
		if _, count := envLookup(env, "CHA_CLAUDE_CLI"); count != 0 {
			t.Fatal("PATH 里有的时候不该补")
		}
	})
	t.Run("固定位置也没有：不补", func(t *testing.T) {
		env := withFallbackCLI("claude-code", []string{"PATH=" + bin, "HOME=" + filepath.Join(root, "empty")})
		if _, count := envLookup(env, "CHA_CLAUDE_CLI"); count != 0 {
			t.Fatal("找不到时不该补")
		}
	})
	t.Run("没有登记固定位置的 harness：不动", func(t *testing.T) {
		env := withFallbackCLI("pi", []string{"PATH=" + bin, "HOME=" + home})
		if _, count := envLookup(env, "PI_CLI"); count != 0 {
			t.Fatal("pi 不该补")
		}
	})

	// 版本一览和引擎看到的是同一份：locateCLI 拿补好的变量当 configured
	env := withFallbackCLI("claude-code", []string{"PATH=" + bin, "HOME=" + home})
	configured, _ := envLookup(env, "CHA_CLAUDE_CLI")
	if found, ok := locateCLI("claude-code", configured, env); !ok || found.path != official || found.overrides {
		t.Fatalf("版本一览应找到同一份: %+v %v", found, ok)
	}
}
