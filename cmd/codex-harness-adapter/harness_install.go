package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
	baseline "github.com/slovx2/litch/protocol"
)

// 给设备装 harness（扩展 harnessInstall，定义在 protocol/extensions/harness-install.json，
// 类型在 packages/protocol/src/device-harness-install.mts）：每个 harness 只登记官方给的那一种装法，
// 验证版取自编进来的 protocol/versions.json，最新版直接问 npm 注册表。装的任务在 harness_install_job.go。
//
// 规矩：只按用户点的按钮或 Agent 的命令装，以用户身份跑（不提权、不用 sudo）；不主动降级，也不要求装精确版本。

const (
	installScript = "script"
	installNPM    = "npm"
)

// 一个 harness 的官方装法。
type installSpec struct {
	// 类 Unix 系统上的装法：installScript 或 installNPM。
	method string
	// Windows 上的装法；空串表示 Windows 上不能由 Litch 装。
	windowsMethod string
	// npm 的包名：npm 装的就装它；查最新版也问它（脚本装的那几家，官方脚本自己也是这么查的）。
	npmPackage string
	// 官方脚本的地址（类 Unix 系统用 bash 跑）和 Windows 的 PowerShell 脚本地址。
	script, windowsScript string
	// 脚本怎么带版本：给出脚本后面跟的参数。
	scriptArgs func(version string) string
	docsURL    string
	// 验证版在 protocol/versions.json 里的键；空串是没有验证记录（界面上只给最新版，标“未验证”）。
	verifiedKey string
	// 适配器要求的最低版本；空串是没有要求。
	minimum string
	// 探测版本时在 PATH 里找的命令名（不带 Windows 的扩展名）。官方装法放到 PATH 以外的位置记在登记表的
	// fallbacks 里（比如 Claude 的 ~/.local/bin），引擎经 withFallbackCLI 拿到同一个路径。
	commands []string
}

// 测试里会换成别的系统。
var installGOOS = runtime.GOOS

var (
	claudeInstall = &installSpec{
		method: installScript, windowsMethod: installScript, npmPackage: "@anthropic-ai/claude-code",
		script: "https://claude.ai/install.sh", windowsScript: "https://claude.ai/install.ps1",
		// 官方脚本的第一个参数就是目标版本（也认 stable、latest）
		scriptArgs: func(version string) string { return version },
		docsURL:    "https://code.claude.com/docs/en/setup", verifiedKey: "claudeCli", minimum: "2.1.282",
		commands: []string{"claude"},
	}
	piInstall = &installSpec{
		method: installNPM, windowsMethod: installNPM, npmPackage: "@earendil-works/pi-coding-agent",
		docsURL: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", verifiedKey: "piCli", minimum: "0.99.1",
		commands: []string{"pi"},
	}
	dshInstall = &installSpec{
		method: installNPM, windowsMethod: installNPM, npmPackage: "@deepseek-ai/dsh",
		docsURL: "https://github.com/deepseek-ai/deepseek-harness", verifiedKey: "dshVerified", minimum: "0.2.0-rc.2",
		commands: []string{"dsh"},
	}
	opencodeInstall = &installSpec{
		// 官方脚本认 --version，只装 1.x；Windows 上官方给的是 npm
		method: installScript, windowsMethod: installNPM, npmPackage: "opencode-ai",
		script:     "https://opencode.ai/install",
		scriptArgs: func(version string) string { return "-- --version " + version },
		docsURL:    "https://opencode.ai/docs/", verifiedKey: "opencodeVerified", minimum: "1.18.0",
		commands: []string{"opencode"},
	}
	geminiInstall = &installSpec{
		method: installNPM, windowsMethod: installNPM, npmPackage: "@google/gemini-cli",
		docsURL: "https://github.com/google-gemini/gemini-cli", commands: []string{"gemini"},
	}
	qwenInstall = &installSpec{
		method: installNPM, windowsMethod: installNPM, npmPackage: "@qwen-code/qwen-code",
		docsURL: "https://github.com/QwenLM/qwen-code", commands: []string{"qwen"},
	}
	codexInstall = &installSpec{
		method: installNPM, windowsMethod: installNPM, npmPackage: "@openai/codex",
		docsURL: "https://developers.openai.com/codex/cli", verifiedKey: "codexVerified", minimum: minimumCodexVersion,
		commands: []string{"codex"},
	}
)

// 自填命令的 acp 没有可装的东西，只给协议的说明。
const acpDocsURL = "https://agentclientprotocol.com/overview/agents"

// 这个系统上用哪种装法；空串是不能由 Litch 装。
func (s *installSpec) methodHere() string {
	if s == nil {
		return ""
	}
	if installGOOS == "windows" {
		return s.windowsMethod
	}
	return s.method
}

func (s *installSpec) verified() string {
	if s == nil || s.verifiedKey == "" {
		return ""
	}
	return baseline.Verified(s.verifiedKey)
}

// 只认这种样子的版本号（它要拼进命令里，注册表给的也一样要过这一关）。
var exactVersion = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z.-]+)?$`)

// 给人看、给人复制的那条官方命令。version 为空时装最新版。
func (s *installSpec) manual(version string) string {
	switch s.methodHere() {
	case installNPM:
		if version == "" {
			version = "latest"
		}
		return fmt.Sprintf("npm install -g %s@%s", s.npmPackage, version)
	case installScript:
		if version == "" {
			version = "latest"
		}
		if installGOOS == "windows" {
			return fmt.Sprintf("& ([scriptblock]::Create((irm %s))) %s", s.windowsScript, s.scriptArgs(version))
		}
		return fmt.Sprintf("curl -fsSL %s | bash -s %s", s.script, s.scriptArgs(version))
	}
	return ""
}

// 真正要跑的命令：程序名（在 PATH 里找）和参数。
func (s *installSpec) argv(version string) (string, []string) {
	switch s.methodHere() {
	case installNPM:
		return "npm", []string{"install", "-g", s.npmPackage + "@" + version}
	case installScript:
		if installGOOS == "windows" {
			return "powershell", []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", s.manual(version)}
		}
		// 下载失败也要算失败：管道的退出码看每一段
		return "bash", []string{"-c", "set -o pipefail; " + s.manual(version)}
	}
	return "", nil
}

// 命令要用到的、得先在 PATH 里找得到的程序。
func (s *installSpec) needs() []string {
	switch s.methodHere() {
	case installNPM:
		return []string{"npm"}
	case installScript:
		if installGOOS == "windows" {
			return []string{"powershell"}
		}
		return []string{"bash", "curl"}
	}
	return nil
}

// 在 PATH 里按系统的规矩找一个程序：Windows 上带 .exe、.cmd。
func lookPath(search, name string) string {
	names := []string{name}
	if installGOOS == "windows" {
		names = []string{name + ".exe", name + ".cmd", name}
	}
	return executableOnPath(search, names)
}

// 环境（KEY=VALUE 列表）里的一个变量。Windows 上 PATH 写作 Path 也认。
func envValue(env []string, names ...string) string {
	for _, name := range names {
		for index := len(env) - 1; index >= 0; index-- {
			key, value, _ := strings.Cut(env[index], "=")
			if key == name {
				return value
			}
		}
	}
	return ""
}

func envPath(env []string) string { return envValue(env, "PATH", "Path") }

func envHome(env []string) string { return envValue(env, "HOME", "USERPROFILE") }

// ---------- 版本探测 ----------

// 跑 `<命令> --version` 最多等这么久。
var versionProbeTimeout = 2 * time.Second

// 找到的命令行在哪。
type locatedCLI struct {
	path string
}

// 显式指定的路径严格保留；未指定时取候选中版本最高的一份。
func locateCLI(id, configured string, env []string) (locatedCLI, bool) {
	if strings.TrimSpace(configured) != "" {
		if path := configuredCLIPath(strings.TrimSpace(configured), env); path != "" {
			return locatedCLI{path: path}, true
		}
		return locatedCLI{}, false
	}
	for _, candidate := range harnessCLICandidates(id, "", env) {
		if candidate.Selected {
			return locatedCLI{path: candidate.Path}, true
		}
	}
	return locatedCLI{}, false
}

// probeVersion 跑 `<path> --version`，从输出里取第一个版本号。跑不起来、超时、取不出都是空串。
func probeVersion(ctx context.Context, path string, env []string) string {
	ctx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()
	command := hostCLICommand(ctx, path, env, "--version")
	command.Env = env
	// 超时连它起的子进程一起停掉，不等它们放开输出管道
	hostplatform.Prepare(command)
	command.Cancel = func() error { return hostplatform.Kill(command) }
	command.WaitDelay = time.Second
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	if err != nil || ctx.Err() != nil {
		return ""
	}
	if version := firstVersion(stdout.String()); version != "" {
		return version
	}
	return firstVersion(stderr.String())
}

// 问 npm 全局目录最多等这么久。
var npmPrefixTimeout = 10 * time.Second

// npmGlobalCLI 问 npm 它的全局目录（npm prefix -g），在那里找这个 harness 的命令：类 Unix 系统在 <前缀>/bin，
// Windows 就在前缀下。npm 装的东西都到这里，不管它在不在 PATH 上。问不出来、没有都是空串。
func npmGlobalCLI(ctx context.Context, install *installSpec, npm string, env []string) string {
	if npm == "" {
		return ""
	}
	prefix := npmGlobalPrefix(ctx, npm, env)
	if prefix == "" {
		return ""
	}
	bin := prefix
	if installGOOS != "windows" {
		bin = filepath.Join(prefix, "bin")
	}
	for _, name := range install.commands {
		if path := lookPath(bin, name); path != "" {
			return path
		}
	}
	return ""
}

// npm 的配置查询单独短缓存；候选文件每次重新 stat，安装结束清掉前缀缓存。
var npmPrefixes = struct {
	sync.Mutex
	values map[string]struct {
		prefix string
		at     time.Time
	}
}{values: map[string]struct {
	prefix string
	at     time.Time
}{}}

func npmGlobalPrefix(ctx context.Context, npm string, env []string) string {
	ordered := []string{}
	for _, value := range env {
		name, _, _ := strings.Cut(value, "=")
		if strings.HasPrefix(strings.ToLower(name), "npm_config_") || name == "PATH" || name == "Path" || name == "HOME" || name == "USERPROFILE" || name == "APPDATA" {
			ordered = append(ordered, value)
		}
	}
	sort.Strings(ordered)
	key := npm + "\n" + strings.Join(ordered, "\n")
	npmPrefixes.Lock()
	defer npmPrefixes.Unlock()
	if cached, ok := npmPrefixes.values[key]; ok && time.Since(cached.at) < 30*time.Second {
		return cached.prefix
	}
	prefix := readNPMGlobalPrefix(ctx, npm, env)
	npmPrefixes.values[key] = struct {
		prefix string
		at     time.Time
	}{prefix, time.Now()}
	return prefix
}

func readNPMGlobalPrefix(ctx context.Context, npm string, env []string) string {
	ctx, cancel := context.WithTimeout(ctx, npmPrefixTimeout)
	defer cancel()
	command := hostCLICommand(ctx, npm, env, "prefix", "-g")
	command.Env = env
	if home := envHome(env); home != "" {
		command.Dir = home
	}
	hostplatform.Prepare(command)
	command.Cancel = func() error { return hostplatform.Kill(command) }
	command.WaitDelay = time.Second
	output, err := command.Output()
	if err != nil || ctx.Err() != nil {
		return ""
	}
	prefix := ""
	for _, line := range strings.Split(string(output), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			prefix = line
		}
	}
	if !filepath.IsAbs(prefix) {
		return ""
	}
	return prefix
}

// 两个路径是不是同一个文件（顺着符号链接看，比如 /usr/local/bin/dsh 链到 npm 全局目录里的那份）。
func sameFile(a, b string) bool {
	first, err := os.Stat(a)
	if err != nil {
		return false
	}
	second, err := os.Stat(b)
	return err == nil && os.SameFile(first, second)
}

func firstVersion(text string) string {
	return versionPattern.FindString(text)
}

// ---------- 最新版 ----------

// 查最新版问的注册表：默认是 npm 的公共注册表，测试时用这个环境变量指到本地的假注册表。
const registryEnvironment = "LITCH_NPM_REGISTRY"

const defaultRegistry = "https://registry.npmjs.org"

var latestTimeout = 5 * time.Second

// fetchLatest 问注册表一个包的 latest 是哪一版：GET <注册表>/<包>/latest，取应答里的 version。
func fetchLatest(ctx context.Context, registry, pkg string) (string, error) {
	if registry == "" {
		registry = defaultRegistry
	}
	ctx, cancel := context.WithTimeout(ctx, latestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(registry, "/")+"/"+pkg+"/latest", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", response.StatusCode)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&body); err != nil {
		return "", errors.New(tr("注册表的应答看不懂", "the registry's answer could not be read"))
	}
	if !exactVersion.MatchString(body.Version) {
		return "", fmt.Errorf(tr("注册表给的版本号不像样：%q", "the registry gave an odd version: %q"), body.Version)
	}
	return body.Version, nil
}

func latestFailure(err error) bilingual {
	if errors.Is(err, context.DeadlineExceeded) {
		return both("查最新版超时（%d 秒）", "Looking up the latest version timed out (%d seconds)").with(int(latestTimeout / time.Second))
	}
	return both("查不到最新版：%s", "Could not look up the latest version: %s").with(err.Error())
}

// ---------- 版本一览 ----------

// litch/device/harness/versions 的一项（HarnessVersionInfo）。
type harnessVersionInfo struct {
	Harness     string                `json:"harness"`
	Candidates  []harnessCLICandidate `json:"candidates,omitempty"`
	Installable bool                  `json:"installable"`
	Method      *string               `json:"method"`
	Installed   *string               `json:"installed"`
	Minimum     *string               `json:"minimum"`
	Verified    *string               `json:"verified"`
	Latest      *string               `json:"latest"`
	LatestError *bilingual            `json:"latestError,omitempty"`
	DocsURL     string                `json:"docsUrl"`
	Manual      string                `json:"manual"`
}

func optional(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// 一次查最新版的结果。
type latestOutcome struct {
	version string
	failure *bilingual
}

// 最新版记着上次注册表查询；本机版本由可执行文件的 stat 缓存负责。
type versionCache struct {
	mu      sync.Mutex
	latests map[string]latestOutcome
}

func newVersionCache() *versionCache { return &versionCache{latests: map[string]latestOutcome{}} }

// 查版本要用到的现场：每个 harness 的环境、设置里给的命令行。
type versionSource struct {
	environment func(id string) []string
	configured  func(id string) string
	registry    string
}

// latest 现查一个包的最新版并记下；refresh 为 false 时只给上次查到的。
func (v *versionCache) latest(ctx context.Context, registry, pkg string, refresh bool) latestOutcome {
	if refresh {
		version, err := fetchLatest(ctx, registry, pkg)
		outcome := latestOutcome{version: version}
		if err != nil {
			failure := latestFailure(err)
			outcome = latestOutcome{failure: &failure}
		}
		v.mu.Lock()
		v.latests[pkg] = outcome
		v.mu.Unlock()
		return outcome
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.latests[pkg]
}

// versions 是 litch/device/harness/versions 的应答：每个 harness 一项，顺序同登记表。几个 harness 一起查。
func (v *versionCache) versions(ctx context.Context, source versionSource, refresh bool) []harnessVersionInfo {
	infos := make([]harnessVersionInfo, len(knownHarnesses))
	var group sync.WaitGroup
	for index, id := range knownHarnesses {
		group.Add(1)
		go func() {
			defer group.Done()
			infos[index] = v.info(ctx, source, id, refresh)
		}()
	}
	group.Wait()
	return infos
}

func (v *versionCache) info(ctx context.Context, source versionSource, id string, refresh bool) harnessVersionInfo {
	install := specOf(id).install
	info := harnessVersionInfo{Harness: id, DocsURL: acpDocsURL, Candidates: harnessCLICandidates(id, source.configured(id), source.environment(id))}
	for _, candidate := range info.Candidates {
		if candidate.Selected {
			info.Installed = optional(candidate.Version)
			break
		}
	}
	if install == nil {
		return info
	}
	info.DocsURL = install.docsURL
	info.Minimum = optional(install.minimum)
	info.Verified = optional(install.verified())
	method := install.methodHere()
	if method == "" {
		return info
	}
	info.Installable, info.Method = true, &method
	info.Manual = install.manual(install.verified())
	outcome := v.latest(ctx, source.registry, install.npmPackage, refresh)
	info.Latest, info.LatestError = optional(outcome.version), outcome.failure
	return info
}

// 查最新版用的注册表：环境变量给了就用它（测试用），否则是 npm 的公共注册表。
func registryFrom(c configuration) string {
	if value := os.Getenv(registryEnvironment); value != "" {
		return value
	}
	return c.userEnv[registryEnvironment]
}
