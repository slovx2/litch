//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelectNewestCLI(t *testing.T) {
	root := t.TempDir()
	first, second := filepath.Join(root, "first", "claude"), filepath.Join(root, "second", "claude")
	official := filepath.Join(root, ".local", "bin", "claude")
	env := []string{"HOME=" + root, "PATH=" + filepath.Dir(first) + ":" + filepath.Dir(second)}
	writeScript(t, first, "echo '2.1.287 (Claude Code)'\n")
	writeScript(t, second, "echo '2.1.300 (Claude Code)'\n")
	writeScript(t, official, "echo '2.1.318 (Claude Code)'\n")
	check := func(configured, want string) {
		t.Helper()
		found, ok := locateCLI("claude-code", configured, env)
		if !ok || found.path != want {
			t.Fatalf("got %+v %v; want %s", found, ok, want)
		}
	}
	check("", official)
	check(first, first)
	check("claude", first)
	passed := withFallbackCLI("claude-code", env)
	if got, _ := envLookup(passed, "CHA_CLAUDE_CLI"); got != official {
		t.Fatal(got)
	}
	// 原地更新后，无需更改设置或重启主进程就能重新探测。
	writeScript(t, first, "echo '2.1.400 (Claude Code)'\n")
	check("", first)
	writeScript(t, second, "echo '2.1.400 (Claude Code)'\n")
	check("", first)
	writeScript(t, first, "echo no-version\n")
	check("", second)
	writeScript(t, second, "echo 9.0.0; exit 1\n")
	writeScript(t, official, "echo no-version\n")
	check("", first)
	if _, ok := locateCLI("claude-code", filepath.Join(root, "missing"), env); ok {
		t.Fatal("不能绕过显式路径")
	}
	// 有的 CLI 把版本写到标准错误，仍然参与同一套排序。
	writeScript(t, second, "echo 2.1.500 >&2\n")
	check("", second)
	// 链到同一文件的多个名字只列一次。
	link := filepath.Join(root, "third", "claude")
	if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(first, link); err != nil {
		t.Fatal(err)
	}
	env[1] += ":" + filepath.Dir(link)
	if got := harnessCLICandidates("claude-code", first, env); len(got) != 3 || !got[0].Selected {
		t.Fatal(got)
	}
}

func TestNewestCLIIncludesNPMGlobal(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	prefix := filepath.Join(root, "global")
	writeScript(t, filepath.Join(bin, "npm"), "echo '"+prefix+"'\n")
	writeScript(t, filepath.Join(bin, "pi"), "echo 1.0.0\n")
	fresh := filepath.Join(prefix, "bin", "pi")
	writeScript(t, fresh, "echo 2.0.0\n")
	env := []string{"HOME=" + root, "PATH=" + bin}
	if found, ok := locateCLI("pi", "", env); !ok || found.path != fresh {
		t.Fatalf("%+v %v", found, ok)
	}
}

func TestInstallScriptWarnsAboutPinnedOldCLI(t *testing.T) {
	rig := newInstallRig(t, "")
	old := filepath.Join(rig.bin, "claude")
	writeScript(t, old, "echo '2.1.287 (Claude Code)'\n")
	rig.configured = old
	writeScript(t, filepath.Join(rig.tools, "curl"), `cat <<'SCRIPT'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho "%s (Claude Code)"\n' "$1" > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
SCRIPT
`)
	if err := os.Symlink("/bin/bash", filepath.Join(rig.tools, "bash")); err != nil {
		t.Fatal(err)
	}
	last := rig.finished(t, rig.start(t, "claude-code", installTargetVerified))
	if last.State != installSucceeded || last.Installed == nil || *last.Installed != "2.1.287" || len(rig.found) != 1 || rig.found[0].path != old {
		t.Fatalf("%+v %+v", last, rig.found)
	}
	log := strings.Join(last.Log, "\n")
	if !strings.Contains(log, "2.1.316") || !strings.Contains(log, "修改或清空命令行路径设置") || !strings.Contains(log, old) {
		t.Fatal(log)
	}
}
