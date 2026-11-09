package main

import (
	"encoding/json"
	"regexp"
	"strings"
)

const claudeToolLoadingKey = "harness.claude-code.toolLoading"
const claudeToolLoadingVariable = "CHA_CLAUDE_TOOL_LOADING"
const claudeToolOverridesKey = "harness.claude-code.toolLoadingOverrides"
const claudeToolOverridesVariable = "CHA_CLAUDE_TOOL_LOADING_OVERRIDES"

func (c configuration) defaultToolLoading(variable, fallback string) string {
	entry := c
	entry.harness, entry.settingsEnv = claudeHarness, c.environmentTable(claudeHarness)
	if value := strings.TrimSpace(entry.environmentValue(variable)); value != "" {
		return value
	}
	return fallback
}

func claudeToolLoadingSettings(c configuration, group string) []settingSpec {
	mode := c.defaultToolLoading(claudeToolLoadingVariable, "auto")
	if mode != "on" && mode != "off" {
		mode = "auto"
	}
	return []settingSpec{
		{Key: claudeToolLoadingKey, Group: group, Type: settingEnum, Scope: harnessScope(claudeHarness), Restart: restartHarness,
			Default: mode, Title: both("工具按需加载", "On-demand tools"),
			Options:     []settingOption{{Value: "auto", Title: both("自动", "Automatic")}, {Value: "on", Title: both("启用", "On")}, {Value: "off", Title: both("关闭", "Off")}},
			Description: both("自动仅在已确认的 CLI、模型与搜索环境下按需加载；未知网关保持常驻。启用可显式选择按需加载，关闭保留常驻。调用方逐工具声明优先。修改后重启 Claude Code 生效。", "Automatic defers tools only for a verified CLI, model and search environment; unknown gateways keep tools upfront. On opts in; Off keeps tools upfront. Explicit per-tool declarations take priority. Restart Claude Code to apply.")},
		{Key: claudeToolOverridesKey, Group: group, Type: settingString, Scope: harnessScope(claudeHarness), Restart: restartHarness,
			Default: c.defaultToolLoading(claudeToolOverridesVariable, ""), Title: both("工具加载覆盖", "Tool loading overrides"),
			Description: both("逗号分隔 namespace=always 或 namespace.tool=defer。always 常驻，defer 按需；逐工具优先。目标和权限工具使用 goal-tools、permission-tools。自动无法确认或关闭时不应用覆盖；调用方声明不变。修改后重启生效。", "Comma-separated namespace=always or namespace.tool=defer; per-tool overrides win. Use goal-tools and permission-tools for built-ins. Overrides do not apply when Automatic cannot verify support or loading is Off; caller declarations are unchanged. Restart to apply.")},
	}
}

func (c configuration) toolLoadingEnvironment(id string, values map[string]string) {
	if id != claudeHarness {
		return
	}
	for key, variable := range map[string]string{claudeToolLoadingKey: claudeToolLoadingVariable, claudeToolOverridesKey: claudeToolOverridesVariable} {
		var value string
		if raw, written := c.settings.lookup(key); written && json.Unmarshal(raw, &value) == nil {
			values[variable] = value
		}
	}
}

var toolLoadingEntry = regexp.MustCompile(`^[\w-]+(\.[\w-]+)?\s*=\s*(always|defer)$`)

func validateToolLoading(lookup func(string) (json.RawMessage, bool)) *settingsProblem {
	raw, written := lookup(claudeToolOverridesKey)
	if !written {
		return nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	for _, entry := range strings.Split(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" && !toolLoadingEntry.MatchString(entry) {
			return invalidSetting(claudeToolOverridesKey, both("请用 namespace=always 或 namespace.tool=defer，逗号分隔", "Use namespace=always or namespace.tool=defer, separated by commas"))
		}
	}
	return nil
}
