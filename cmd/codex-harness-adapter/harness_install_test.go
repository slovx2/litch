package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	baseline "github.com/slovx2/litch/protocol"
)

// 登记表：每个 harness 都登记了装法，验证版指到 versions.json 的键，下限和适配器原有的一致。
func TestInstallTable(t *testing.T) {
	want := map[string]struct {
		method, pkg, verified, minimum string
	}{
		"claude-code": {installScript, "@anthropic-ai/claude-code", baseline.Verified("claudeCli"), "2.1.282"},
		"pi":          {installNPM, "@earendil-works/pi-coding-agent", baseline.Verified("piCli"), "0.99.1"},
		"dsh":         {installNPM, "@deepseek-ai/dsh", baseline.Verified("dshVerified"), "0.2.0-rc.2"},
		"opencode":    {installScript, "opencode-ai", baseline.Verified("opencodeVerified"), "1.18.0"},
		"gemini":      {installNPM, "@google/gemini-cli", "", ""},
		"qwen":        {installNPM, "@qwen-code/qwen-code", "", ""},
		nativeCodex:   {installNPM, "@openai/codex", baseline.Verified("codexVerified"), minimumCodexVersion},
	}
	saved := installGOOS
	installGOOS = "darwin"
	t.Cleanup(func() { installGOOS = saved })
	for _, spec := range harnessTable {
		install := spec.install
		if spec.id == "acp" {
			if install != nil {
				t.Fatal("自填命令的 acp 不该能装")
			}
			continue
		}
		expected, listed := want[spec.id]
		if !listed || install == nil {
			t.Fatalf("%s 没有登记装法", spec.id)
		}
		if install.methodHere() != expected.method || install.npmPackage != expected.pkg || install.verified() != expected.verified || install.minimum != expected.minimum {
			t.Fatalf("%s 的装法不对: %+v", spec.id, install)
		}
		if install.docsURL == "" || !strings.HasPrefix(install.docsURL, "https://") {
			t.Fatalf("%s 没有官方说明的地址", spec.id)
		}
		if expected.verified != "" && !exactVersion.MatchString(expected.verified) {
			t.Fatalf("%s 的验证版不像版本号: %q", spec.id, expected.verified)
		}
	}
	// 数组取最后一个，字符串原样
	if baseline.Verified("codexVerified") != "0.163.0" || baseline.Verified("claudeCli") != "2.1.282" || baseline.Verified("nope") != "" {
		t.Fatalf("versions.json 读得不对: %q %q", baseline.Verified("codexVerified"), baseline.Verified("claudeCli"))
	}
}

// 给人复制的命令和真正跑的命令：两个官方脚本带版本的写法、npm 的写法；Windows 上各自换成官方给的那种。
func TestInstallCommands(t *testing.T) {
	saved := installGOOS
	t.Cleanup(func() { installGOOS = saved })
	installGOOS = "linux"
	cases := map[string]string{
		claudeInstall.manual("2.1.282"):   "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.282",
		opencodeInstall.manual("1.18.33"): "curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.33",
		piInstall.manual("0.99.1"):        "npm install -g @earendil-works/pi-coding-agent@0.99.1",
		geminiInstall.manual(""):          "npm install -g @google/gemini-cli@latest",
	}
	for got, want := range cases {
		if got != want {
			t.Fatalf("命令不对: %q，应为 %q", got, want)
		}
	}
	if name, args := claudeInstall.argv("2.1.282"); name != "bash" || strings.Join(args, " ") != "-c set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s 2.1.282" {
		t.Fatalf("脚本要经 bash 跑、管道看每一段: %s %v", name, args)
	}
	if name, args := codexInstall.argv("0.160.0"); name != "npm" || strings.Join(args, " ") != "install -g @openai/codex@0.160.0" {
		t.Fatalf("npm 的参数不对: %s %v", name, args)
	}
	if strings.Join(claudeInstall.needs(), ",") != "bash,curl" || strings.Join(piInstall.needs(), ",") != "npm" {
		t.Fatal("要先找的程序不对")
	}
	installGOOS = "windows"
	if got := claudeInstall.manual("2.1.282"); got != "& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) 2.1.282" {
		t.Fatalf("Windows 上的 Claude 命令不对: %q", got)
	}
	if name, _ := claudeInstall.argv("2.1.282"); name != "powershell" {
		t.Fatalf("Windows 上的脚本要经 PowerShell 跑: %s", name)
	}
	if opencodeInstall.methodHere() != installNPM || opencodeInstall.manual("1.18.33") != "npm install -g opencode-ai@1.18.33" {
		t.Fatalf("Windows 上 OpenCode 走 npm: %q", opencodeInstall.manual("1.18.33"))
	}
	if codexInstall.methodHere() != installNPM || codexInstall.manual("0.163.0") != "npm install -g @openai/codex@0.163.0" {
		t.Fatalf("Windows 上的原生 Codex 走 npm: %q", codexInstall.manual("0.163.0"))
	}
}

func TestFirstVersion(t *testing.T) {
	cases := map[string]string{
		"2.1.286 (Claude Code)\n": "2.1.286",
		"codex-cli 0.160.0":       "0.160.0",
		"dsh 0.2.0-rc.2\n":        "0.2.0-rc.2",
		"v1.18.33":                "1.18.33",
		"no version here":         "",
	}
	for output, want := range cases {
		if got := firstVersion(output); got != want {
			t.Fatalf("%q 取出 %q，应为 %q", output, got, want)
		}
	}
	for _, bad := range []string{"1.2", "1.2.3; rm -rf /", "1.2.3 ", "latest", "../1.2.3"} {
		if exactVersion.MatchString(bad) {
			t.Fatalf("%q 不该当成版本号", bad)
		}
	}
}

// 最新版从注册表的 /<包>/latest 取；查不到、超时、版本号不像样都给出原因。
func TestFetchLatest(t *testing.T) {
	var mu sync.Mutex
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/@anthropic-ai/claude-code/latest":
			_, _ = w.Write([]byte(`{"name":"@anthropic-ai/claude-code","version":"2.1.303"}`))
		case "/odd/latest":
			_, _ = w.Write([]byte(`{"version":"1.0.0; rm -rf ~"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	ctx := context.Background()
	if version, err := fetchLatest(ctx, server.URL+"/", "@anthropic-ai/claude-code"); err != nil || version != "2.1.303" {
		t.Fatalf("最新版: %q %v", version, err)
	}
	if _, err := fetchLatest(ctx, server.URL, "odd"); err == nil {
		t.Fatal("不像样的版本号应当算查不到")
	}
	if _, err := fetchLatest(ctx, server.URL, "missing"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("没有这个包: %v", err)
	}
	if failure := latestFailure(context.DeadlineExceeded); !strings.Contains(failure.ZH, "超时") || !strings.Contains(failure.EN, "timed out") {
		t.Fatalf("超时的说法: %+v", failure)
	}
	if len(paths) != 3 || paths[0] != "/@anthropic-ai/claude-code/latest" {
		t.Fatalf("请求的路径: %v", paths)
	}
}
