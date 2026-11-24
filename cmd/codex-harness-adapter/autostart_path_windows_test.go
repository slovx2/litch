package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/sys/windows/registry"
)

// 任务计划程序自启的环境：注册表里系统和用户的 Path（Git 等）都在，npm 全局目录里的 codex.cmd 找得到，
// 手填的命令行路径照常优先。APPDATA、USERPROFILE 换成临时目录，不碰真实的用户目录。
func TestAutostartServiceEnvFindsNPMCodexOnWindows(t *testing.T) {
	root := t.TempDir()
	appData := filepath.Join(root, "Roaming")
	t.Setenv("APPDATA", appData)
	npmCodex := filepath.Join(appData, "npm", "codex.cmd")
	writeWindowsFakeCLI(t, npmCodex, "codex-cli 999.0.0")
	manual := filepath.Join(root, "manual", "codex.cmd")
	writeWindowsFakeCLI(t, manual, "codex-cli 1.0.0")
	node := filepath.Join(root, "litch", "node", "node.exe")

	env := []string{}
	for _, entry := range autostartServiceEnv(node) {
		if name, _, _ := strings.Cut(entry, "="); strings.EqualFold(name, "USERPROFILE") {
			entry = "USERPROFILE=" + root
		}
		env = append(env, entry)
	}
	path := filepath.SplitList(envValue(env, "PATH"))
	if path[len(path)-1] != filepath.Dir(node) {
		t.Fatalf("Node 所在目录应排在最后：%v", path)
	}
	machine := readRegistryPath(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`)
	for _, directory := range strings.Split(machine, ";") {
		directory = strings.TrimRight(strings.TrimSpace(directory), `\`)
		if directory != "" && !slices.ContainsFunc(path, func(entry string) bool { return strings.EqualFold(strings.TrimRight(entry, `\`), directory) }) {
			t.Fatalf("系统 Path 里的 %s 不在自启的 PATH 里：%v", directory, path)
		}
	}

	found, ok := locateCLI(nativeCodex, "", env)
	if !ok || !strings.EqualFold(found.path, npmCodex) {
		t.Fatalf("自启环境没找到 npm 全局目录里的 codex.cmd：%+v %v，PATH=%v", found, ok, path)
	}
	found, ok = locateCLI(nativeCodex, manual, env)
	if !ok || !strings.EqualFold(found.path, manual) {
		t.Fatalf("手填的命令行路径应优先：%+v %v", found, ok)
	}
}

func writeWindowsFakeCLI(t *testing.T, path, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("@echo "+version+"\r\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
