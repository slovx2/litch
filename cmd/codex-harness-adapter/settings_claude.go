package main

import (
	"encoding/json"
	"strings"
)

// Claude Code 的提示缓存时长：落到运行时的环境变量 CHA_CLAUDE_PROMPT_CACHE_TTL 上（packages/claude/src/runtime-config.mts），
// 取值 default（和官方 CLI 一样，入口什么都不设）或 1h。运行时起来时读一次，所以改了要重启它。

const (
	claudeHarness          = "claude-code"
	claudeCacheTTLKey      = "harness.claude-code.promptCacheTtl"
	claudeCacheTTLVariable = "CHA_CLAUDE_PROMPT_CACHE_TTL"
	claudeCacheTTLDefault  = "default"
	claudeCacheTTLHour     = "1h"
)

// 设置里写过、认得的值；没写过或认不出是空串。
func (c configuration) claudeCacheTTL() string {
	raw, written := c.settings.lookup(claudeCacheTTLKey)
	var value string
	if !written || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	if value != claudeCacheTTLDefault && value != claudeCacheTTLHour {
		return ""
	}
	return value
}

// 设置里没写过时它算哪一档：看 Claude Code 的运行时照更低几层（设置里的环境变量表、启动服务的环境、
// 环境文件）起来会拿到什么，和运行时实际的一致（和 Pi 的审批开关同样的做法）。
func (c configuration) defaultClaudeCacheTTL() string {
	entry := c
	entry.harness, entry.settingsEnv = claudeHarness, c.environmentTable(claudeHarness)
	if strings.EqualFold(strings.TrimSpace(entry.environmentValue(claudeCacheTTLVariable)), claudeCacheTTLHour) {
		return claudeCacheTTLHour
	}
	return claudeCacheTTLDefault
}

func claudeCacheTTLSetting(c configuration, group string) settingSpec {
	return settingSpec{
		Key: claudeCacheTTLKey, Group: group, Type: settingEnum, Scope: harnessScope(claudeHarness), Restart: restartHarness,
		Default: c.defaultClaudeCacheTTL(), Title: both("提示缓存时长", "Prompt cache duration"),
		Options: []settingOption{
			{Value: claudeCacheTTLDefault, Title: both("跟官方一致", "Same as Claude Code")},
			{Value: claudeCacheTTLHour, Title: both("1 小时", "1 hour")},
		},
		Description: both(
			"Claude 会把对话里前面不变的部分缓存起来，下一轮再用时更便宜也更快。官方默认缓存 5 分钟（用 Claude 订阅登录时是 1 小时）。"+
				"改成 1 小时后，长对话里隔一阵再接着聊也还接得上缓存，少花重新写入的钱；但每次写入缓存的单价更高（约为普通输入的 2 倍，5 分钟缓存是 1.25 倍），"+
				"所以短对话、聊完就走的用法不一定划算。子代理和后台请求仍用 5 分钟。改了之后 Claude Code 重启才生效。",
			"Claude caches the unchanged start of a conversation so the next turn costs less and responds faster. By default the cache lasts 5 minutes (1 hour when signed in with a Claude subscription). "+
				"With 1 hour, long conversations still hit the cache after a pause, so you pay less for writing it again; but each cache write costs more (about 2× normal input, versus 1.25× for the 5-minute cache), "+
				"so it may not pay off for short, one-off chats. Subagents and background requests keep 5 minutes. Takes effect after Claude Code restarts.",
		),
	}
}
