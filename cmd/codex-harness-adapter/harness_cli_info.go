package main

import "strings"

// 启动这一轮时检查到的入口与版本，不根据后来改过的设置重新推测正在运行的进程。
type harnessCLIInfo struct {
	Path      string `json:"path"`
	Version   string `json:"version"`
	Source    string `json:"source"`
	StartedAt int64  `json:"startedAt"`
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
	} else if spec := specOf(c.harness); !spec.native && len(spec.fallbacks) > 0 && commandOnPath(c.environmentValue("PATH", "Path"), spec) == "" {
		source = "default"
	}
	return &harnessCLIInfo{Path: path, Version: versionPattern.FindString(version), Source: source}
}
