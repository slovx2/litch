package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 经理与工作线共享这几个席位。先抢席位再启动 Node，饱和时立即退出，不挂起等待进程。
const agentCommandSlots = 8
const agentCommandTimeout = 5 * time.Minute

func acquireAgentCommandSlot(directory string) (*os.File, error) {
	for n := range agentCommandSlots {
		file, err := os.OpenFile(filepath.Join(directory, fmt.Sprintf("slot-%d", n)), os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			return nil, err
		}
		if hostplatform.Lock(file) == nil {
			return file, nil
		}
		_ = file.Close()
	}
	return nil, &exitError{75, errors.New(tr("GitHub 命令并发已满，请稍后重试", "too many GitHub commands; retry shortly"))}
}

// 跳过 Git 的全局选项，只放行已知本地内建命令。别名及可能访问远端的命令仍由凭据入口处理。
func localGitCommand(args []string) bool {
	for len(args) > 0 {
		arg := args[0]
		args = args[1:]
		switch arg {
		case "-c", "-C":
			if len(args) == 0 {
				return true // Git 自己报参数错误。
			}
			args = args[1:]
			continue
		case "--bare", "--no-pager", "--paginate", "-p", "-P", "--no-replace-objects",
			"--no-optional-locks", "--no-lazy-fetch", "--literal-pathspecs", "--glob-pathspecs",
			"--noglob-pathspecs", "--icase-pathspecs":
			continue
		case "--version", "-v", "--help", "-h", "version", "rev-parse", "status", "config",
			"ls-files", "check-ignore", "check-attr", "show-ref", "for-each-ref", "symbolic-ref", "branch", "tag":
			return true
		case "remote":
			// show 和 prune 可联网，update 会 fetch。
			for len(args) != 0 && (args[0] == "-v" || args[0] == "--verbose") {
				args = args[1:]
			}
			return len(args) == 0 || args[0] == "get-url" || args[0] == "set-url"
		}
		if strings.HasPrefix(arg, "--git-dir=") || strings.HasPrefix(arg, "--work-tree=") ||
			strings.HasPrefix(arg, "--namespace=") || strings.HasPrefix(arg, "--config-env=") ||
			(strings.HasPrefix(arg, "-C") && len(arg) > 2) {
			continue
		}
		return false
	}
	return true
}

func agentHostEnvironment(directory string, env []string) (result []string, path string) {
	shims, _ := os.Stat(directory)
	for _, entry := range env {
		name, value, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "PATH") {
			var directories []string
			var search []string
			for _, item := range filepath.SplitList(value) {
				abs, err := filepath.Abs(item)
				if err == nil && (abs == directory || runtime.GOOS == "windows" && strings.EqualFold(abs, directory)) {
					continue
				}
				// 即使 PATH 通过另一个符号链接指向同一 shim，也不能执行到自己。
				if item != "" && shims != nil {
					if info, err := os.Stat(item); err == nil && os.SameFile(info, shims) {
						continue
					}
				}
				directories = append(directories, item)
				if filepath.IsAbs(item) {
					search = append(search, item)
				}
			}
			path = strings.Join(search, string(os.PathListSeparator))
			entry = name + "=" + strings.Join(directories, string(os.PathListSeparator))
		}
		result = append(result, entry)
	}
	return result, path
}

func agentHasGithubContext() bool {
	var thread string
	switch os.Getenv("LITCH_DEVICE_GITHUB_HARNESS") {
	case "":
		return false
	case "codex":
		thread = os.Getenv("CODEX_THREAD_ID")
	case "pi":
		thread = os.Getenv("PI_SESSION_ID")
	case "dsh":
		thread = os.Getenv("DSH_SESSION_ID")
	default:
		thread = os.Getenv("LITCH_THREAD_ID")
		if thread == "" {
			thread = threadIDFromFile(os.Getenv(threadIDFileEnvironment))
		}
	}
	return thread != "" && os.Getenv(deviceSocketEnvironment) != ""
}

// 进程起来时还不知道会话号的（Gemini 的会话进程，见 packages/acp/src/session-agents.mts），环境里放这个变量
// 指向一个文件，会话号写在文件里；LITCH_THREAD_ID 为空时才看（与 packages/shared/src/device-github-environment.mts 一致）。
const threadIDFileEnvironment = "LITCH_THREAD_ID_FILE"

func threadIDFromFile(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 512 {
		return ""
	}
	value := strings.TrimSpace(string(data))
	if value == "" || len(value) > 256 {
		return ""
	}
	for _, r := range value {
		if !(r == '_' || r == ':' || r == '.' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return ""
		}
	}
	return value
}

func runAgentCommand(ctx context.Context, args []string) error {
	if len(args) < 4 || !filepath.IsAbs(args[0]) || !filepath.IsAbs(args[1]) || !filepath.IsAbs(args[2]) ||
		(args[3] != "git" && args[3] != "gh") {
		return errors.New("invalid agent command")
	}
	directory, node, script, mode, argv := filepath.Clean(args[0]), args[1], args[2], args[3], args[4:]
	env, path := agentHostEnvironment(directory, os.Environ())
	names := []string{mode}
	if runtime.GOOS == "windows" {
		names = []string{mode + ".exe"}
	}
	binary := executableOnPath(path, names)
	// 注入的会话里 gh 一律用设备给的版本和身份，gh --version 也不例外，以免报出宿主 gh 的版本。
	needsScope := agentHasGithubContext() && !(mode == "git" && localGitCommand(argv))
	if !needsScope {
		if binary == "" {
			return &exitError{127, fmt.Errorf("%s: executable not found", mode)}
		}
		if runtime.GOOS != "windows" {
			// 原位切换为宿主程序；短命令不留包装父进程，不连接设备，也不启动 Node。
			return execAgentHost(binary, append([]string{binary}, argv...), env)
		}
	}
	if needsScope {
		binary, argv = node, append([]string{script, mode}, argv...)
	}
	return runAgentBounded(ctx, directory, agentCommandTimeout, binary, argv, env)
}

func runAgentCredential(ctx context.Context, args []string) error {
	if len(args) != 8 || !filepath.IsAbs(args[0]) || !filepath.IsAbs(args[1]) ||
		!filepath.IsAbs(args[2]) || args[6] != "git" {
		return errors.New("invalid agent credential command")
	}
	if args[7] != "get" {
		return nil // Git 审批与删除时，设备凭据从不交给宿主存储。
	}
	// Git 可以并行访问多个子模块。凭据助手单独计数，避免等待正在调用它的外层 Git。
	return runAgentBounded(ctx, args[0], 8*time.Second, args[1], args[2:], os.Environ())
}

func runAgentBounded(ctx context.Context, directory string, timeout time.Duration, binary string, argv, env []string) error {
	slot, err := acquireAgentCommandSlot(directory)
	if err != nil {
		return err
	}
	defer slot.Close()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, binary, argv...)
	command.Env = env
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	keepAgentSlot(command, slot)
	err = runBoundedChild(command)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &exitError{124, errors.New(tr("GitHub 命令超时", "GitHub command timed out"))}
	}
	var exited *exec.ExitError
	if errors.As(err, &exited) && exited.ExitCode() >= 0 {
		return &exitError{exited.ExitCode(), errors.New("")}
	}
	return err
}
