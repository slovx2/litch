package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestAdapterVersionSources(t *testing.T) {
	root := t.TempDir()
	if got := adapterVersion(root); got != unknownVersion {
		t.Fatalf("没有 package.json 时应给占位值: %s", got)
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"name":"codex-harness-adapter","version":"1.2.3"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := adapterVersion(root); got != "1.2.3" {
		t.Fatalf("应读安装根目录下 package.json 的版本号: %s", got)
	}
	// 构建时写入的版本号优先。
	buildVersion = "9.9.9"
	t.Cleanup(func() { buildVersion = "" })
	if got := adapterVersion(root); got != "9.9.9" {
		t.Fatalf("构建时写入的版本号没有生效: %s", got)
	}
}

// version 这个拼写可用，标准输出只有一行“codex-harness-adapter <版本号>”。
func TestVersionCommand(t *testing.T) {
	for _, spelling := range []string{"version", "--version"} {
		output, err := captureTerminal(t, func() error { return run(t.Context(), []string{spelling}) })
		if err != nil || !regexp.MustCompile(`^codex-harness-adapter \S+\n$`).MatchString(output) {
			t.Fatalf("%s 的输出不对: %q %v", spelling, output, err)
		}
	}
	if err := run(t.Context(), []string{"version", "--home", t.TempDir()}); err == nil {
		t.Fatal("version 不接受参数")
	}
}

// 三条新子命令不能挤掉帮助第一行的子命令清单：Homebrew 配方的自检按它匹配。
func TestUsageKeepsCommandListAndMentionsNewCommands(t *testing.T) {
	for _, lang := range []language{chinese, english} {
		outputLanguage = lang
		text := usage()
		outputLanguage = chinese
		if !regexp.MustCompile(`^[^\n]*start\|init\|serve\|ssh-config\|doctor`).MatchString(text) {
			t.Fatalf("帮助第一行的子命令清单变了: %s", text)
		}
		for _, name := range []string{"version", "device-start", "device-stop", "--if-idle", "device-proxy", "--ssh=on|off"} {
			if !regexp.MustCompile(regexp.QuoteMeta(name)).MatchString(text) {
				t.Fatalf("帮助里没有 %s", name)
			}
		}
	}
}
