package main

import "strings"

// Windows 受管服务的 PATH（纯字符串拼接，各平台都能测）：System32 打头，接着照登录环境的次序放
// 注册表里系统和用户的 Path（已展开 %VAR%；Git for Windows、Node 安装器都登记在这里），
// 再保底补 npm 全局目录 %APPDATA%\npm 和官方安装脚本常用的 %USERPROFILE%\.local\bin，最后是登记的 Node 所在目录。
// 不区分大小写、忽略末尾反斜杠去重，保留第一次出现的位置。
func windowsAutostartPath(system string, registryPaths []string, appData, profile, node string) string {
	entries := []string{system}
	for _, value := range registryPaths {
		entries = append(entries, strings.Split(value, ";")...)
	}
	if appData != "" {
		entries = append(entries, strings.TrimRight(appData, `\`)+`\npm`)
	}
	if profile != "" {
		entries = append(entries, strings.TrimRight(profile, `\`)+`\.local\bin`)
	}
	if at := strings.LastIndexAny(node, `\/`); at > 0 {
		entries = append(entries, node[:at])
	}
	seen := map[string]bool{}
	result := []string{}
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		key := strings.ToLower(strings.TrimRight(entry, `\/`))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, entry)
	}
	return strings.Join(result, ";")
}
