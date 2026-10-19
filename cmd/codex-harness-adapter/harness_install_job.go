package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 安装任务：一台设备同一时刻只跑一个（npm 的全局目录并发写会坏），按用户的环境跑官方的命令，
// 不提权、不用 sudo。输出留末尾 200 行，进度节流着推出去；装成后重探版本，再交给 after
// （常驻服务里是：停用的写成启用、命令行不在 harness 找得到的地方就写进设置，然后照 harness.apply 重启它）。

const (
	installRunning   = "running"
	installSucceeded = "succeeded"
	installFailed    = "failed"

	installTargetVerified = "verified"
	installTargetLatest   = "latest"
)

// 安装命令最多跑这么久，到了就连它起的子进程一起停掉。
var installTimeout = 10 * time.Minute

// 推进度的最小间隔：日志一直在长时，最多这么久推一次。状态变了马上推。
var installNotifyInterval = 500 * time.Millisecond

// 日志留多少行、一行最多留多长。
const (
	installLogLines     = 200
	installLogLineBytes = 2000
)

// 一个安装任务（HarnessInstallJob）。
type installJob struct {
	Job       string     `json:"job"`
	Harness   string     `json:"harness"`
	Version   string     `json:"version"`
	Resolved  *string    `json:"resolved"`
	State     string     `json:"state"`
	Command   string     `json:"command"`
	Log       []string   `json:"log"`
	StartedAt int64      `json:"startedAt"`
	EndedAt   *int64     `json:"endedAt"`
	Installed *string    `json:"installed,omitempty"`
	Failure   *bilingual `json:"failure,omitempty"`
}

// 安装要用到的现场，常驻服务给真的，测试给假的。
type installHooks struct {
	// 查版本用的现场（环境、设置里的命令行、设置的版本号、注册表）。跑安装命令也用这份环境。
	source versionSource
	// 任务变了（开始、日志长了、结束）：推给设备进程。拿到的是一份拷贝。
	notify func(job installJob)
	// 装成了、找到了命令行之后的事。返回要记进日志的几行。
	after func(ctx context.Context, id string, found locatedCLI) []string
}

type installer struct {
	ctx   context.Context
	hooks installHooks
	cache *versionCache

	mu      sync.Mutex
	current *installJob
	// 每个 harness 最近一次的任务（含正在跑的那个）。
	last map[string]*installJob
	next int
	// 正在跑的任务结束时关上，测试和停服务等它。
	done chan struct{}
}

func newInstaller(ctx context.Context, hooks installHooks) *installer {
	return &installer{ctx: ctx, hooks: hooks, cache: newVersionCache(), last: map[string]*installJob{}}
}

// 开始装失败时回的原因，和控制通道的错误同形。
func installRejected(reason string, id string, text bilingual) *controlError {
	return &controlError{Reason: reason, Harness: id, Text: text}
}

// start 开始装一个 harness，立刻返回任务号；进度看 notify。
func (i *installer) start(id, target string) (string, *controlError) {
	if !isKnownHarness(id) {
		return "", unknownHarness(id)
	}
	if target != installTargetVerified && target != installTargetLatest {
		return "", &controlError{Reason: "invalid", Text: both("version 只能是 verified 或 latest", "version must be verified or latest")}
	}
	install := specOf(id).install
	if install.methodHere() == "" {
		return "", installRejected("failed", id, both(
			"%s 在这个系统上不能由 Litch 装，请照官方说明自己装",
			"%s cannot be installed by Litch on this system; install it yourself as its documentation describes",
		).with(harnessNames[id]))
	}
	resolved := ""
	if target == installTargetVerified {
		if resolved = install.verified(); resolved == "" {
			return "", &controlError{Reason: "invalid", Harness: id, Text: both(
				"%s 没有验证过的版本，只能装最新版", "%s has no verified version; only the latest can be installed",
			).with(harnessNames[id])}
		}
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.current != nil {
		running := i.current.Harness
		return "", installRejected("busy", running, both(
			"这台设备正在装 %s，等它装完再装别的", "This device is installing %s; wait for it to finish first",
		).with(harnessNames[running]))
	}
	i.next++
	job := &installJob{
		Job: fmt.Sprintf("install-%d-%d", time.Now().UnixMilli(), i.next), Harness: id, Version: target,
		Resolved: optional(resolved), State: installRunning, Log: []string{}, StartedAt: time.Now().UnixMilli(),
	}
	if resolved != "" {
		job.Command = install.manual(resolved)
	}
	i.current, i.last[id] = job, job
	i.done = make(chan struct{})
	go i.run(job, install, resolved)
	return job.Job, nil
}

// jobs 是 install/read 的应答：每个 harness 最近一次的任务，按开始的先后。
func (i *installer) jobs() []installJob {
	i.mu.Lock()
	defer i.mu.Unlock()
	jobs := []installJob{}
	for _, job := range i.last {
		jobs = append(jobs, copyJob(job))
	}
	for a := 1; a < len(jobs); a++ {
		for b := a; b > 0 && jobs[b].StartedAt < jobs[b-1].StartedAt; b-- {
			jobs[b], jobs[b-1] = jobs[b-1], jobs[b]
		}
	}
	return jobs
}

// wait 等正在跑的任务结束（测试、停服务用）。
func (i *installer) wait() {
	i.mu.Lock()
	done := i.done
	i.mu.Unlock()
	if done != nil {
		<-done
	}
}

func copyJob(job *installJob) installJob {
	copied := *job
	copied.Log = append([]string{}, job.Log...)
	return copied
}

// 推一份现在的样子。拿着锁调用。
func (i *installer) publish(job *installJob) {
	if i.hooks.notify != nil {
		i.hooks.notify(copyJob(job))
	}
}

func (i *installer) update(job *installJob, change func()) {
	i.mu.Lock()
	change()
	i.publish(job)
	i.mu.Unlock()
}

func (i *installer) finish(job *installJob, installed string, failure *bilingual) {
	i.mu.Lock()
	ended := time.Now().UnixMilli()
	job.EndedAt = &ended
	if failure != nil {
		job.State, job.Failure = installFailed, failure
	} else {
		job.State, job.Installed = installSucceeded, &installed
	}
	if i.current == job {
		i.current = nil
	}
	i.publish(job)
	done := i.done
	i.mu.Unlock()
	if done != nil {
		close(done)
	}
}

func (i *installer) run(job *installJob, install *installSpec, resolved string) {
	ctx := i.ctx
	id := job.Harness
	i.mu.Lock()
	i.publish(job)
	i.mu.Unlock()
	if resolved == "" {
		version, err := fetchLatest(ctx, i.hooks.source.registry, install.npmPackage)
		if err != nil {
			failure := latestFailure(err)
			i.finish(job, "", &failure)
			return
		}
		resolved = version
		i.update(job, func() { job.Resolved, job.Command = &resolved, install.manual(resolved) })
	}
	env := installEnvironment(i.hooks.source.environment(id))
	search := envPath(env)
	for _, need := range install.needs() {
		if lookPath(search, need) != "" {
			continue
		}
		var failure bilingual
		if need == "npm" {
			failure = both(
				"npm 不在 PATH 上：先装好 Node.js（带 npm），或者照官方说明用别的方式装",
				"npm is not on PATH: install Node.js (with npm) first, or install it another way as the official documentation describes",
			)
		} else {
			failure = both("找不到 %s 命令，官方的安装命令要用它", "The %s command was not found; the official install command needs it").with(need)
		}
		i.finish(job, "", &failure)
		return
	}
	name, args := install.argv(resolved)
	if failure := i.execute(ctx, job, lookPath(search, name), args, env); failure != nil {
		i.finish(job, "", failure)
		return
	}
	// 装成了：重探版本（缓存作废），找不到命令行就算没装成
	i.cache.forget(id)
	configured := i.hooks.source.configured(id)
	found, ok := locateCLI(id, configured, env)
	if !ok && strings.TrimSpace(configured) != "" {
		// 给的那一项是坏的（旧的路径、指到不存在的文件）：照没给时的次序再找，找到了就让它盖过那一项
		if found, ok = locateCLI(id, "", env); ok {
			found.overrides = true
		}
	}
	if !ok {
		failure := both(
			"安装命令跑完了，但找不到 %s 的命令行：它装到的目录可能不在 PATH 上。把那个目录加进 PATH，或者在设置里填它的命令行路径，然后点“重新检测”",
			"The install command finished, but the %s command-line tool cannot be found: the directory it went to may not be on PATH. Add that directory to PATH, or set its CLI path in settings, then check again",
		).with(harnessNames[id])
		i.finish(job, "", &failure)
		return
	}
	installed := probeVersion(ctx, found.path, env)
	if installed == "" {
		failure := both(
			"安装命令跑完了，但 %s --version 没有给出版本号", "The install command finished, but %s --version gave no version",
		).with(found.path)
		i.finish(job, "", &failure)
		return
	}
	if i.hooks.after != nil {
		for _, line := range i.hooks.after(ctx, id, found) {
			i.update(job, func() { appendLog(job, line) })
		}
	}
	i.cache.forget(id)
	i.finish(job, installed, nil)
}

// 跑安装命令时的环境：harness 起的时候看到的那一份，去掉适配器给运行时的固定变量（与装东西无关，也不该漏给安装脚本）。
func installEnvironment(env []string) []string {
	fixed := map[string]bool{"CODEX_HOME": true, "CHA_CLAUDE_IDLE_EXIT_MS": true, acpAgentVariable: true, adapterCLIEnvironment: true, deviceSocketEnvironment: true}
	for _, spec := range harnessTable {
		if spec.homeVariable != "" {
			fixed[spec.homeVariable] = true
		}
	}
	result := []string{}
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if !fixed[name] {
			result = append(result, entry)
		}
	}
	return result
}

func appendLog(job *installJob, line string) {
	if len(line) > installLogLineBytes {
		line = line[:installLogLineBytes] + "…"
	}
	job.Log = append(job.Log, strings.ToValidUTF8(line, "�"))
	if extra := len(job.Log) - installLogLines; extra > 0 {
		job.Log = append([]string{}, job.Log[extra:]...)
	}
}

// 输出里的进度条用回车覆盖同一行：按换行和回车都切开。
func splitLines(data []byte, atEOF bool) (int, []byte, error) {
	for index, b := range data {
		if b == '\n' || b == '\r' {
			return index + 1, data[:index], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	if len(data) >= 64*1024 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// execute 跑安装命令，输出进日志，按时推进度。成功返回 nil，否则是失败的原因。
func (i *installer) execute(ctx context.Context, job *installJob, path string, args []string, env []string) *bilingual {
	command := exec.Command(path, args...)
	command.Env = env
	if home := envHome(env); home != "" {
		command.Dir = home
	}
	// 装好的东西若在后台留了进程、还拿着输出管道，最多再等这么久就不等它了
	command.WaitDelay = 5 * time.Second
	hostplatform.Prepare(command)
	reader, writer := io.Pipe()
	command.Stdout, command.Stderr = writer, writer
	if err := command.Start(); err != nil {
		failure := both("安装命令没能启动：%s", "The install command could not start: %s").with(err.Error())
		return &failure
	}
	release, _ := hostplatform.Track(command)
	defer release()
	exited := make(chan error, 1)
	go func() {
		err := command.Wait()
		_ = writer.Close()
		exited <- err
	}()
	lines := make(chan string, 256)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 64*1024)
		scanner.Split(splitLines)
		for scanner.Scan() {
			if text := strings.TrimRight(scanner.Text(), " \t"); text != "" {
				lines <- text
			}
		}
		_, _ = io.Copy(io.Discard, reader)
	}()
	deadline := time.NewTimer(installTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(installNotifyInterval)
	defer ticker.Stop()
	dirty, timedOut, canceled := false, false, false
	stopping := ctx.Done()
	var waitErr error
	finished := false
	for !finished {
		select {
		case line, open := <-lines:
			if !open {
				lines = nil
				continue
			}
			i.mu.Lock()
			appendLog(job, line)
			i.mu.Unlock()
			dirty = true
		case <-ticker.C:
			if dirty {
				i.mu.Lock()
				i.publish(job)
				i.mu.Unlock()
				dirty = false
			}
		case <-deadline.C:
			timedOut = true
			_ = hostplatform.Kill(command)
		case <-stopping:
			stopping, canceled = nil, true
			_ = hostplatform.Kill(command)
		case waitErr = <-exited:
			finished = true
		}
	}
	// 管道里剩下的行收完
	if lines != nil {
		for line := range lines {
			i.mu.Lock()
			appendLog(job, line)
			i.mu.Unlock()
		}
	}
	switch {
	case timedOut:
		failure := both("超过 %d 分钟没有装完，已经停掉", "It did not finish within %d minutes and was stopped").with(int(installTimeout / time.Minute))
		return &failure
	case canceled:
		failure := both("设备服务停了，安装没有做完", "The device service stopped before the install finished")
		return &failure
	case waitErr == nil:
		return nil
	}
	code := -1
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		code = exitErr.ExitCode()
	}
	failure := classifyInstallFailure(job.Log, code)
	return &failure
}

var (
	permissionProblem = regexp.MustCompile(`(?i)\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|access is denied`)
	networkProblem    = regexp.MustCompile(`(?i)\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|could not resolve host|failed to connect|network is unreachable|curl: \((5|6|7|28|35|56)\)|unable to connect to the remote server|tls handshake`)
)

// 安装命令以非零退出码结束：从日志里认权限和网络两种常见原因，认不出就照实说退出码。
func classifyInstallFailure(log []string, code int) bilingual {
	text := strings.Join(log, "\n")
	switch {
	case permissionProblem.MatchString(text):
		return both(
			"权限不够：要写的目录（多半是 npm 的全局目录）当前用户写不了。Litch 不用 sudo 提权；把 npm 的全局目录换到用户目录下（npm config set prefix ~/.npm-global，并把 ~/.npm-global/bin 加进 PATH），或者用官方说明里的别的方式装（退出码 %d）",
			"Permission denied: the current user cannot write to the target directory (most likely npm's global directory). Litch does not use sudo; point npm's global directory at your home (npm config set prefix ~/.npm-global and add ~/.npm-global/bin to PATH), or install it another way as the official documentation describes (exit code %d)",
		).with(code, code)
	case networkProblem.MatchString(text):
		return both("网络不通：下载没有成功，检查网络和代理后再试（退出码 %d）", "Network problem: the download failed; check the network and proxy settings and try again (exit code %d)").with(code, code)
	}
	return both("安装命令以退出码 %s 结束，详情见日志", "The install command ended with exit code %s; see the log").with(strconv.Itoa(code))
}
