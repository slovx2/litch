package main

import (
	"path/filepath"
	"strings"
)

// 启动这一轮时检查到的入口与版本，不根据后来改过的设置重新推测正在运行的进程。
type harnessCLIInfo struct {
	Path       string                `json:"path"`
	Version    string                `json:"version"`
	Source     string                `json:"source"`
	Candidates []harnessCLICandidate `json:"candidates,omitempty"`
	StartedAt  int64                 `json:"startedAt"`
}

func selectedHarnessCLI(c configuration, path, version string) *harnessCLIInfo {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	source := "path"
	env := map[string]string{}
	for _, entry := range c.baseEnvironment() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	if c.settings.text(cliPathKey(c.harness)) != "" {
		source = "settings"
	} else if variable := harnessCLIVariable[c.harness]; variable != "" && strings.TrimSpace(env[variable]) != "" {
		source = "environment"
	} else {
		spec := specOf(c.harness)
		names := append([]string{}, spec.commands...)
		if spec.install != nil {
			names = append(names, spec.install.commands...)
		}
		onPath := false
		for _, directory := range filepath.SplitList(env["PATH"] + string(filepath.ListSeparator) + env["Path"]) {
			if directory == "" {
				continue
			}
			for _, name := range names {
				candidate := hostCLIExecutable(lookPath(directory, name))
				if candidate != "" && sameFile(candidate, path) {
					onPath = true
				}
			}
		}
		if !onPath {
			source = "default"
		}
	}
	return &harnessCLIInfo{Path: path, Version: versionPattern.FindString(version), Source: source, Candidates: harnessCLICandidates(c.harness, path, c.baseEnvironment())}
}
