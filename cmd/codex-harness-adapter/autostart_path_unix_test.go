//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func autostartTestPath(env []string) []string {
	return filepath.SplitList(envValue(env, "PATH"))
}

// 受管服务的 PATH 带着标准安装位置，与登记的是哪个 Node 无关；Node 所在目录仍排在最后。
func TestAutostartServicePathKeepsStandardDirectories(t *testing.T) {
	for _, node := range []string{"/usr/local/bin/node", "/opt/litch/0.50.0/libexec/node/bin/node"} {
		path := autostartTestPath(autostartServiceEnv(node))
		want := []string{"/usr/local/bin"}
		if runtime.GOOS == "darwin" {
			want = []string{"/opt/homebrew/bin", "/usr/local/bin"}
		}
		for _, directory := range want {
			at := slices.Index(path, directory)
			if at < 0 || at > slices.Index(path, "/usr/bin") {
				t.Fatalf("Node %s：PATH 缺 %s 或排在系统目录之后：%v", node, directory, path)
			}
		}
		if path[len(path)-1] != filepath.Dir(node) {
			t.Fatalf("Node 所在目录应排在最后：%v", path)
		}
		if !slices.ContainsFunc(path, func(directory string) bool { return strings.HasSuffix(directory, "/.local/bin") }) {
			t.Fatalf("PATH 缺 ~/.local/bin：%v", path)
		}
	}
	// 调用服务管理器的环境只要系统目录。
	if path := autostartTestPath(autostartBaseEnv()); !slices.Equal(path, autostartSystemPath) {
		t.Fatalf("管理器调用的 PATH：%v", path)
	}
}

// 登记的是随包带的 Node 时，自启环境照样找得到标准位置（如 /usr/local/bin）里的 codex；手填的命令行路径照常优先。
func TestAutostartServiceEnvFindsStandardCodex(t *testing.T) {
	root := t.TempDir()
	standard := filepath.Join(root, "usr-local-bin")
	writeAutostartFakeCLI(t, filepath.Join(standard, "codex"), "codex-cli 999.0.0")
	manual := filepath.Join(root, "manual", "codex")
	writeAutostartFakeCLI(t, manual, "codex-cli 1.0.0")
	home := filepath.Join(root, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	previous := autostartStandardPath
	autostartStandardPath = func() []string { return []string{standard} }
	t.Cleanup(func() { autostartStandardPath = previous })

	bundled := filepath.Join(root, "litch", "libexec", "node", "bin", "node")
	env := []string{}
	for _, entry := range autostartServiceEnv(bundled) {
		name, value, _ := strings.Cut(entry, "=")
		switch name {
		case "HOME":
			// 不碰真实的主目录：换成临时的，PATH 里由真实主目录拼出的 ~/.local/bin 也去掉
			entry = "HOME=" + home
		case "PATH":
			kept := slices.DeleteFunc(filepath.SplitList(value), func(directory string) bool {
				return strings.HasSuffix(directory, "/.local/bin")
			})
			entry = "PATH=" + strings.Join(kept, string(os.PathListSeparator))
		}
		env = append(env, entry)
	}

	found, ok := locateCLI(nativeCodex, "", env)
	if !ok || found.path != filepath.Join(standard, "codex") {
		t.Fatalf("自启环境没找到标准位置的 codex：%+v %v，PATH=%s", found, ok, envValue(env, "PATH"))
	}
	found, ok = locateCLI(nativeCodex, manual, env)
	if !ok || found.path != manual {
		t.Fatalf("手填的命令行路径应优先：%+v %v", found, ok)
	}
}

func writeAutostartFakeCLI(t *testing.T, path, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho '"+version+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
