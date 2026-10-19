//go:build !windows

package main

// 安装任务对着临时 PATH 里的假 npm、假 curl 跑：成功和各种失败、超时、同一时刻只跑一个、日志只留末尾、
// 装成后交给 after；版本一览和缓存。绝不碰本机真的 npm 和官方脚本。

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type installRig struct {
	tools, bin, home string
	env              []string
	installer        *installer
	settings         int
	mu               sync.Mutex
	notices          []installJob
	found            []locatedCLI
}

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
}

// 一套假的现场：tools 里放假的 npm、curl（和指向真 bash 的 bash），bin 是“全局目录”，home 是临时的主目录。
// 自带 /bin:/usr/bin 是为了 sh、mkdir、chmod 这些；假的排在前面。
func newInstallRig(t *testing.T, registry string) *installRig {
	t.Helper()
	root := t.TempDir()
	rig := &installRig{tools: filepath.Join(root, "tools"), bin: filepath.Join(root, "bin"), home: filepath.Join(root, "home")}
	for _, dir := range []string{rig.tools, rig.bin, rig.home} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	rig.env = []string{"PATH=" + rig.tools + ":" + rig.bin + ":/bin:/usr/bin", "HOME=" + rig.home, "FAKE_BIN=" + rig.bin,
		"CODEX_HOME=/should/not/leak"}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		rig.installer.wait()
	})
	rig.installer = newInstaller(ctx, installHooks{
		source: versionSource{
			environment: func(string) []string { return rig.env },
			configured:  func(string) string { return "" },
			settings:    func() int { rig.mu.Lock(); defer rig.mu.Unlock(); return rig.settings },
			registry:    registry,
		},
		notify: func(job installJob) {
			rig.mu.Lock()
			rig.notices = append(rig.notices, job)
			rig.mu.Unlock()
		},
		after: func(_ context.Context, id string, found locatedCLI) []string {
			rig.mu.Lock()
			rig.found = append(rig.found, found)
			rig.mu.Unlock()
			return []string{"[litch] after " + id}
		},
	})
	return rig
}

// 假的 npm：把参数和看到的 CODEX_HOME 记下来，再按 body 做事。
func (r *installRig) fakeNPM(t *testing.T, body string) {
	writeScript(t, filepath.Join(r.tools, "npm"), `echo "npm $*"
echo "CODEX_HOME=${CODEX_HOME:-unset}"
`+body)
}

// 在“全局目录”里放一个假命令，--version 打出这一版。
func fakeCommand(name, version string) string {
	return fmt.Sprintf(`printf '#!/bin/sh\necho "%s %s"\n' > "$FAKE_BIN/%s"
/bin/chmod +x "$FAKE_BIN/%s"
`, name, version, name, name)
}

func (r *installRig) start(t *testing.T, id, target string) string {
	t.Helper()
	job, failure := r.installer.start(id, target)
	if failure != nil {
		t.Fatalf("没能开始装 %s: %+v", id, failure)
	}
	return job
}

// 等任务结束，返回最后一条通知。
func (r *installRig) finished(t *testing.T, job string) installJob {
	t.Helper()
	r.installer.wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.notices) == 0 {
		t.Fatal("一条通知都没有")
	}
	last := r.notices[len(r.notices)-1]
	if last.Job != job || last.State == installRunning || last.EndedAt == nil {
		t.Fatalf("最后一条通知应是结束了的这个任务: %+v", last)
	}
	for _, notice := range r.notices {
		if notice.Job == job {
			if notice.State != installRunning {
				t.Fatalf("这个任务的第一条通知应是开始: %+v", notice)
			}
			break
		}
	}
	return last
}

func TestInstallNPMSucceeds(t *testing.T) {
	rig := newInstallRig(t, "")
	rig.fakeNPM(t, fakeCommand("gemini", "0.10.0"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/@google/gemini-cli/latest" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"version":"0.10.0"}`))
	}))
	defer server.Close()
	rig.installer.hooks.source.registry = server.URL
	// Gemini 没有验证版：只能装最新版
	if _, failure := rig.installer.start("gemini", installTargetVerified); failure == nil || failure.Reason != "invalid" {
		t.Fatalf("没有验证版时装验证版应被拒绝: %+v", failure)
	}
	job := rig.start(t, "gemini", installTargetLatest)
	last := rig.finished(t, job)
	if last.State != installSucceeded || last.Installed == nil || *last.Installed != "0.10.0" || last.Resolved == nil || *last.Resolved != "0.10.0" {
		t.Fatalf("应装成 0.10.0: %+v", last)
	}
	if last.Command != "npm install -g @google/gemini-cli@0.10.0" {
		t.Fatalf("命令: %q", last.Command)
	}
	log := strings.Join(last.Log, "\n")
	if !strings.Contains(log, "npm install -g @google/gemini-cli@0.10.0") || !strings.Contains(log, "CODEX_HOME=unset") || !strings.HasSuffix(log, "[litch] after gemini") {
		t.Fatalf("日志不对（固定变量不该漏给安装命令，after 的话接在后面）:\n%s", log)
	}
	if len(rig.found) != 1 || rig.found[0].installer || rig.found[0].path != filepath.Join(rig.bin, "gemini") {
		t.Fatalf("交给 after 的命令行: %+v", rig.found)
	}
	jobs := rig.installer.jobs()
	if len(jobs) != 1 || jobs[0].Job != job || jobs[0].State != installSucceeded {
		t.Fatalf("install/read: %+v", jobs)
	}
}

// Claude 的官方脚本：curl 取脚本、bash -s <版本> 跑；装到 ~/.local/bin（不在 PATH 上），交给 after 时标明是在官方位置找到的。
func TestInstallScriptSucceeds(t *testing.T) {
	rig := newInstallRig(t, "")
	writeScript(t, filepath.Join(rig.tools, "curl"), `echo "$*" > "$HOME/curl-args"
cat <<'EOF'
echo "Installing Claude Code $1"
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho "%s (Claude Code)"\n' "$1" > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
EOF
`)
	if err := os.Symlink("/bin/bash", filepath.Join(rig.tools, "bash")); err != nil {
		t.Fatal(err)
	}
	job := rig.start(t, "claude-code", installTargetVerified)
	last := rig.finished(t, job)
	if last.State != installSucceeded || *last.Installed != "2.1.282" || last.Command != "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.282" {
		t.Fatalf("应装成验证版 2.1.282: %+v", last)
	}
	if data, _ := os.ReadFile(filepath.Join(rig.home, "curl-args")); strings.TrimSpace(string(data)) != "-fsSL https://claude.ai/install.sh" {
		t.Fatalf("curl 的参数: %q", data)
	}
	if len(rig.found) != 1 || !rig.found[0].installer || rig.found[0].path != filepath.Join(rig.home, ".local", "bin", "claude") {
		t.Fatalf("应在官方位置找到: %+v", rig.found)
	}
}

func TestInstallFailures(t *testing.T) {
	cases := []struct {
		name, npm, want string
	}{
		{"权限", "echo 'npm ERR! code EACCES' >&2\nexit 243\n", "权限不够"},
		{"网络", "echo 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org' >&2\nexit 1\n", "网络不通"},
		{"退出码", "echo 'something else' >&2\nexit 3\n", "退出码 3"},
		{"装完找不到", "exit 0\n", "找不到"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			rig := newInstallRig(t, "")
			rig.fakeNPM(t, item.npm)
			job := rig.start(t, "pi", installTargetVerified)
			last := rig.finished(t, job)
			if last.State != installFailed || last.Failure == nil || !strings.Contains(last.Failure.ZH, item.want) || last.Failure.EN == "" || last.Installed != nil {
				t.Fatalf("失败原因应含 %q: %+v", item.want, last)
			}
			if len(rig.found) != 0 {
				t.Fatal("没装成不该交给 after")
			}
		})
	}
	t.Run("npm 不在 PATH 上", func(t *testing.T) {
		rig := newInstallRig(t, "")
		rig.env = []string{"PATH=" + rig.tools, "HOME=" + rig.home}
		last := rig.finished(t, rig.start(t, "dsh", installTargetVerified))
		if last.Failure == nil || !strings.Contains(last.Failure.ZH, "npm 不在 PATH 上") || !strings.Contains(last.Failure.EN, "npm is not on PATH") {
			t.Fatalf("应说 npm 不在 PATH 上: %+v", last)
		}
	})
	t.Run("脚本缺 curl", func(t *testing.T) {
		rig := newInstallRig(t, "")
		if err := os.Symlink("/bin/bash", filepath.Join(rig.tools, "bash")); err != nil {
			t.Fatal(err)
		}
		rig.env = []string{"PATH=" + rig.tools, "HOME=" + rig.home}
		last := rig.finished(t, rig.start(t, "opencode", installTargetVerified))
		if last.Failure == nil || !strings.Contains(last.Failure.ZH, "找不到 curl 命令") {
			t.Fatalf("应说找不到 curl: %+v", last)
		}
	})
	t.Run("查不到最新版", func(t *testing.T) {
		server := httptest.NewServer(http.NotFoundHandler())
		defer server.Close()
		rig := newInstallRig(t, server.URL)
		rig.fakeNPM(t, "exit 0\n")
		last := rig.finished(t, rig.start(t, "qwen", installTargetLatest))
		if last.Failure == nil || !strings.Contains(last.Failure.ZH, "查不到最新版") || last.Resolved != nil || last.Command != "" {
			t.Fatalf("应说查不到最新版: %+v", last)
		}
	})
	t.Run("不认识、不能装", func(t *testing.T) {
		rig := newInstallRig(t, "")
		if _, failure := rig.installer.start("nope", installTargetVerified); failure == nil || failure.Reason != "unknownHarness" {
			t.Fatalf("不认识的 harness: %+v", failure)
		}
		if _, failure := rig.installer.start("acp", installTargetLatest); failure == nil || failure.Reason != "failed" {
			t.Fatalf("acp 不能装: %+v", failure)
		}
		if _, failure := rig.installer.start("pi", "newest"); failure == nil || failure.Reason != "invalid" {
			t.Fatalf("version 不认识: %+v", failure)
		}
	})
}

// 超时：连命令起的子进程一起停掉。
func TestInstallTimeout(t *testing.T) {
	saved := installTimeout
	installTimeout = 300 * time.Millisecond
	t.Cleanup(func() { installTimeout = saved })
	rig := newInstallRig(t, "")
	marker := filepath.Join(rig.home, "late")
	rig.fakeNPM(t, "(sleep 1; touch '"+marker+"') &\nsleep 1\ntouch '"+marker+"'\n")
	started := time.Now()
	last := rig.finished(t, rig.start(t, "pi", installTargetVerified))
	if last.Failure == nil || !strings.Contains(last.Failure.ZH, "没有装完") || time.Since(started) > 5*time.Second {
		t.Fatalf("应按超时失败: %+v", last)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("超时后命令和它的子进程应被停掉")
	}
}

// 同一台设备同一时刻只跑一个；日志只留末尾 200 行；日志长时节流着推。
func TestInstallOneAtATimeAndLogTail(t *testing.T) {
	saved := installNotifyInterval
	installNotifyInterval = 50 * time.Millisecond
	t.Cleanup(func() { installNotifyInterval = saved })
	rig := newInstallRig(t, "")
	rig.fakeNPM(t, `i=1
while [ $i -le 300 ]; do echo "line $i"; i=$((i+1)); done
sleep 0.5
`+fakeCommand("pi", "0.99.1"))
	job := rig.start(t, "pi", installTargetVerified)
	if _, failure := rig.installer.start("dsh", installTargetVerified); failure == nil || failure.Reason != "busy" || failure.Harness != "pi" {
		t.Fatalf("已有任务在跑时应拒绝，并说正在装的是哪个: %+v", failure)
	}
	last := rig.finished(t, job)
	if last.State != installSucceeded || len(last.Log) != installLogLines || last.Log[len(last.Log)-1] != "[litch] after pi" || last.Log[len(last.Log)-2] != "line 300" {
		t.Fatalf("日志应只留末尾 200 行: %d %v", len(last.Log), last.Log[len(last.Log)-3:])
	}
	rig.mu.Lock()
	notices := len(rig.notices)
	rig.mu.Unlock()
	if notices < 3 || notices > 60 {
		t.Fatalf("通知应节流着发: %d 条", notices)
	}
	// 结束了就能再装
	rig.fakeNPM(t, fakeCommand("dsh", "0.2.0-rc.2"))
	if last := rig.finished(t, rig.start(t, "dsh", installTargetVerified)); last.State != installSucceeded {
		t.Fatalf("上一个结束后应能再装: %+v", last)
	}
	if jobs := rig.installer.jobs(); len(jobs) != 2 || jobs[0].Harness != "pi" || jobs[1].Harness != "dsh" {
		t.Fatalf("install/read 按开始的先后给每个 harness 最近一次: %+v", jobs)
	}
}

// 版本一览：已装的探测出来并缓存到设置变化；最新版只在要求时现查；不能装的没有命令。
func TestHarnessVersions(t *testing.T) {
	saved := versionProbeTimeout
	versionProbeTimeout = 300 * time.Millisecond
	t.Cleanup(func() { versionProbeTimeout = saved })
	var mu sync.Mutex
	asked := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/@google/gemini-cli/latest" {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"version":"9.9.9"}`))
	}))
	defer server.Close()
	rig := newInstallRig(t, server.URL)
	writeScript(t, filepath.Join(rig.bin, "gemini"), "echo 0.9.1\n")
	writeScript(t, filepath.Join(rig.bin, "dsh"), "sleep 5\n")
	writeScript(t, filepath.Join(rig.home, ".opencode", "bin", "opencode"), "echo 1.18.40\n")
	source := rig.installer.hooks.source
	cache := rig.installer.cache
	byID := func(infos []harnessVersionInfo) map[string]harnessVersionInfo {
		found := map[string]harnessVersionInfo{}
		for _, info := range infos {
			found[info.Harness] = info
		}
		return found
	}
	started := time.Now()
	infos := cache.versions(context.Background(), source, false)
	if len(infos) != len(knownHarnesses) || time.Since(started) > 3*time.Second {
		t.Fatalf("每个 harness 一项、一起查: %d 项，%v", len(infos), time.Since(started))
	}
	found := byID(infos)
	gemini, opencode, acp, claude, dsh := found["gemini"], found["opencode"], found["acp"], found["claude-code"], found["dsh"]
	if gemini.Installed == nil || *gemini.Installed != "0.9.1" || gemini.Verified != nil || !gemini.Installable || *gemini.Method != installNPM || gemini.Manual != "npm install -g @google/gemini-cli@latest" || gemini.Latest != nil {
		t.Fatalf("gemini: %+v", gemini)
	}
	if opencode.Installed == nil || *opencode.Installed != "1.18.40" {
		t.Fatalf("OpenCode 在 ~/.opencode/bin 里也找得到: %+v", opencode)
	}
	if dsh.Installed != nil {
		t.Fatalf("--version 超时的算探测不出: %+v", dsh)
	}
	if acp.Installable || acp.Method != nil || acp.Manual != "" || acp.Installed != nil || acp.DocsURL == "" {
		t.Fatalf("acp 不能装: %+v", acp)
	}
	if claude.Installed != nil || *claude.Verified != "2.1.282" || *claude.Minimum != "2.1.282" || claude.Manual != "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.282" {
		t.Fatalf("claude: %+v", claude)
	}
	mu.Lock()
	if len(asked) != 0 {
		t.Fatalf("没要最新版时不该联网: %v", asked)
	}
	mu.Unlock()
	// 现查最新版：查到的、查不到的都记下，下次不带 latest 时给上次的
	found = byID(cache.versions(context.Background(), source, true))
	if found["claude-code"].Latest == nil || *found["claude-code"].Latest != "9.9.9" || found["gemini"].Latest != nil || found["gemini"].LatestError == nil {
		t.Fatalf("最新版: %+v %+v", found["claude-code"], found["gemini"])
	}
	writeScript(t, filepath.Join(rig.bin, "gemini"), "echo 0.9.2\n")
	found = byID(cache.versions(context.Background(), source, false))
	if *found["gemini"].Installed != "0.9.1" || *found["claude-code"].Latest != "9.9.9" || found["gemini"].LatestError == nil {
		t.Fatalf("设置没变时用缓存，最新版给上次的: %+v", found["gemini"])
	}
	rig.mu.Lock()
	rig.settings++
	rig.mu.Unlock()
	if found = byID(cache.versions(context.Background(), source, false)); *found["gemini"].Installed != "0.9.2" {
		t.Fatalf("设置变了要重探: %+v", found["gemini"])
	}
}

// 设置里的命令行路径：给了路径就看它，给了命令名就在 PATH 里找，给的不对就是没装。
func TestLocateCLI(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	writeScript(t, filepath.Join(bin, "my-gemini"), "echo 1.0.0\n")
	env := []string{"PATH=" + bin, "HOME=" + root}
	if found, ok := locateCLI("gemini", filepath.Join(bin, "my-gemini"), env); !ok || found.path != filepath.Join(bin, "my-gemini") {
		t.Fatalf("给了路径: %+v %v", found, ok)
	}
	if found, ok := locateCLI("gemini", "my-gemini", env); !ok || found.path != filepath.Join(bin, "my-gemini") {
		t.Fatalf("给了命令名: %+v %v", found, ok)
	}
	if _, ok := locateCLI("gemini", filepath.Join(root, "missing"), env); ok {
		t.Fatal("给的路径不存在就是没装")
	}
	if _, ok := locateCLI("gemini", "", env); ok {
		t.Fatal("PATH 里没有 gemini")
	}
}
