package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// 候选按发现顺序保留；同版本不换位，PATH 顺序优先于固定目录与 npm 全局目录。
type harnessCLICandidate struct {
	Path     string `json:"path"`
	Version  string `json:"version"`
	Selected bool   `json:"selected"`
}

type cliVersionKey struct {
	path     string
	size     int64
	modified int64
}

type cliVersionResult struct {
	ready   chan struct{}
	version string
}

var cliVersions = struct {
	sync.Mutex
	values map[cliVersionKey]*cliVersionResult
}{values: map[cliVersionKey]*cliVersionResult{}}

// 每次 stat 跟随符号链接，既能识别替换链接，也能识别原地升级。失败结果同样缓存。
func cachedCLIVersion(ctx context.Context, path string, env []string) string {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	file, err := os.Stat(real)
	if err != nil {
		return ""
	}
	key := cliVersionKey{real, file.Size(), file.ModTime().UnixNano()}
	cliVersions.Lock()
	if cached, found := cliVersions.values[key]; found {
		cliVersions.Unlock()
		select {
		case <-cached.ready:
			return cached.version
		case <-ctx.Done():
			return ""
		}
	}
	cached := &cliVersionResult{ready: make(chan struct{})}
	for previous := range cliVersions.values {
		if previous.path == real {
			delete(cliVersions.values, previous)
		}
	}
	cliVersions.values[key] = cached
	cliVersions.Unlock()
	cached.version = probeVersion(ctx, path, env)
	close(cached.ready)
	return cached.version
}

func configuredCLIPath(configured string, env []string) string {
	if !strings.ContainsAny(configured, `/\`) {
		return hostCLIExecutable(lookPath(envPath(env), configured))
	}
	return hostCLIExecutable(lookPath(filepath.Dir(configured), filepath.Base(configured)))
}

// Go 为受管引擎作唯一选择，再把绝对路径交给引擎。显式指定不参与择优，但仍列出其他安装供诊断。
func harnessCLICandidates(id, configured string, env []string) []harnessCLICandidate {
	spec := specOf(id)
	names := append([]string{}, spec.commands...)
	if spec.install != nil {
		names = append(names, spec.install.commands...)
	}
	candidates := []harnessCLICandidate{}
	add := func(path string) {
		if path == "" {
			return
		}
		absolute, err := filepath.Abs(hostCLIExecutable(path))
		if err != nil {
			return
		}
		for _, candidate := range candidates {
			if sameFile(candidate.Path, absolute) {
				return
			}
		}
		candidates = append(candidates, harnessCLICandidate{Path: absolute, Version: ""})
	}
	for _, directory := range filepath.SplitList(envPath(env)) {
		if directory == "" {
			continue
		}
		for _, name := range names {
			variants := []string{name}
			if installGOOS == "windows" {
				variants = []string{name + ".exe", name + ".cmd", name}
			}
			for _, variant := range variants {
				add(executableOnPath(directory, []string{variant}))
			}
		}
	}
	if home := envHome(env); home != "" {
		for _, fallback := range spec.fallbacks {
			path := filepath.Join(home, fallback)
			add(lookPath(filepath.Dir(path), filepath.Base(path)))
		}
	}
	if spec.install != nil {
		add(npmGlobalCLI(context.Background(), spec.install, lookPath(envPath(env), "npm"), env))
	}
	configured = strings.TrimSpace(configured)
	explicit := ""
	if configured != "" {
		explicit = configuredCLIPath(configured, env)
		add(explicit)
	}
	var probes sync.WaitGroup
	for index := range candidates {
		probes.Add(1)
		go func() {
			defer probes.Done()
			candidates[index].Version = cachedCLIVersion(context.Background(), candidates[index].Path, env)
		}()
	}
	probes.Wait()
	best := -1
	for index, candidate := range candidates {
		if configured != "" {
			if explicit != "" && sameFile(candidate.Path, explicit) {
				best = index
				break
			}
			continue
		}
		if best < 0 {
			best = index
			continue
		}
		previous := candidates[best].Version
		order, _ := compareVersions(candidate.Version, previous)
		if candidate.Version != "" && (previous == "" || order > 0) {
			best = index
		}
	}
	if best >= 0 {
		candidates[best].Selected = true
	}
	return candidates
}

func newerCLINote(id, path, version string, env []string) bilingual {
	notes := []string{}
	for _, candidate := range harnessCLICandidates(id, path, env) {
		if order, valid := compareVersions(candidate.Version, version); valid && order > 0 {
			notes = append(notes, candidate.Version+" · "+candidate.Path)
		}
	}
	if len(notes) == 0 {
		return both("", "")
	}
	return both("；其他位置有更新版本：%s；请修改命令行路径设置", "; newer copies: %s; change the CLI path setting").with(strings.Join(notes, ", "))
}
