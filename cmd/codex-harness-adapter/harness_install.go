package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
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
	// 探测版本时在 PATH 里找的命令名（不带 Windows 的扩展名）。
	commands []string
	// 官方装法把命令行放在这里（相对用户主目录），而引擎自己不去这里找：装完只在这里找到时，
	// 把它写进设置的“命令行路径”，harness 才起得来。
	installedAt []string
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
		commands: []string{"claude"}, installedAt: []string{filepath.Join(".local", "bin", "claude")},
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
		// Windows 上还接不进原生 Codex（inspectCodex），装了也用不上
		method: installNPM, npmPackage: "@openai/codex",
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

// 找到的命令行：在哪，是不是只在官方装法的位置（installedAt）找到的。
type locatedCLI struct {
	path      string
	installer bool
}

// locateCLI 照 harness 自己找命令行的次序找：设置里的命令行路径（或它的环境变量），PATH 里的命令名，
// 登记表里引擎会去看的固定位置，最后是官方装法的位置。configured 是设置或环境变量给的那一项。
func locateCLI(id, configured string, env []string) (locatedCLI, bool) {
	spec := specOf(id)
	install := spec.install
	if configured = strings.TrimSpace(configured); configured != "" {
		if !strings.ContainsAny(configured, `/\`) {
			// 只给了命令名（ACP 那几个可以这样写）：在 PATH 里找
			if path := lookPath(envPath(env), configured); path != "" {
				return locatedCLI{path: path}, true
			}
			return locatedCLI{}, false
		}
		if executableOnPath(filepath.Dir(configured), []string{filepath.Base(configured)}) != "" {
			return locatedCLI{path: configured}, true
		}
		return locatedCLI{}, false
	}
	names := append([]string{}, spec.commands...)
	if install != nil {
		names = append(names, install.commands...)
	}
	for _, name := range names {
		if path := lookPath(envPath(env), name); path != "" {
			return locatedCLI{path: path}, true
		}
	}
	home := envHome(env)
	if home == "" {
		return locatedCLI{}, false
	}
	look := func(relative string) string {
		path := filepath.Join(home, relative)
		return lookPath(filepath.Dir(path), filepath.Base(path))
	}
	for _, fallback := range spec.fallbacks {
		if path := look(fallback); path != "" {
			return locatedCLI{path: path}, true
		}
	}
	if install != nil {
		for _, relative := range install.installedAt {
			if path := look(relative); path != "" {
				return locatedCLI{path: path, installer: true}, true
			}
		}
	}
	return locatedCLI{}, false
}

// probeVersion 跑 `<path> --version`，从输出里取第一个版本号。跑不起来、超时、取不出都是空串。
func probeVersion(ctx context.Context, path string, env []string) string {
	ctx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = env
	// 超时连它起的子进程一起停掉，不等它们放开输出管道
	hostplatform.Prepare(command)
	command.Cancel = func() error { return hostplatform.Kill(command) }
	command.WaitDelay = time.Second
	output, _ := command.CombinedOutput()
	if ctx.Err() != nil {
		return ""
	}
	return firstVersion(string(output))
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
	Harness     string     `json:"harness"`
	Installable bool       `json:"installable"`
	Method      *string    `json:"method"`
	Installed   *string    `json:"installed"`
	Minimum     *string    `json:"minimum"`
	Verified    *string    `json:"verified"`
	Latest      *string    `json:"latest"`
	LatestError *bilingual `json:"latestError,omitempty"`
	DocsURL     string     `json:"docsUrl"`
	Manual      string     `json:"manual"`
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

// 探测过的已装版本，和探测时设置的版本号：设置变了（命令行路径、环境变量）就要重探。
type probedVersion struct {
	version  string
	settings int
}

// 版本的缓存：已装版本缓存到下次安装或设置变化，最新版记着上次查到的。
type versionCache struct {
	mu      sync.Mutex
	probed  map[string]probedVersion
	latests map[string]latestOutcome
}

func newVersionCache() *versionCache {
	return &versionCache{probed: map[string]probedVersion{}, latests: map[string]latestOutcome{}}
}

func (v *versionCache) forget(id string) {
	v.mu.Lock()
	delete(v.probed, id)
	v.mu.Unlock()
}

// 查版本要用到的现场：每个 harness 的环境、设置里给的命令行，设置现在的版本号。
type versionSource struct {
	environment func(id string) []string
	configured  func(id string) string
	settings    func() int
	registry    string
}

// installed 给出一个 harness 装的版本，先看缓存。
func (v *versionCache) installed(ctx context.Context, source versionSource, id string) string {
	settings := source.settings()
	v.mu.Lock()
	cached, found := v.probed[id]
	v.mu.Unlock()
	if found && cached.settings == settings {
		return cached.version
	}
	version := ""
	env := source.environment(id)
	if located, ok := locateCLI(id, source.configured(id), env); ok {
		version = probeVersion(ctx, located.path, env)
	}
	v.mu.Lock()
	v.probed[id] = probedVersion{version: version, settings: settings}
	v.mu.Unlock()
	return version
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
	info := harnessVersionInfo{Harness: id, Installed: optional(v.installed(ctx, source, id)), DocsURL: acpDocsURL}
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
