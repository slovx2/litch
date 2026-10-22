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

// Claude Code 的会话间消息（CLI 自带的本机收件箱）：落到运行时的环境变量 CHA_CLAUDE_CROSS_SESSION_INBOX 上
// （packages/claude/src/runtime-config.mts），on 时本机别的 Claude 会话能给 Litch 的 Claude 会话发消息，off 时收件箱关掉。
// 运行时起来时读一次，改了要重启它。

const (
	claudeInboxKey      = "harness.claude-code.crossSessionInbox"
	claudeInboxVariable = "CHA_CLAUDE_CROSS_SESSION_INBOX"
)

// 设置里写过时的值；没写过、写的不是布尔时 written 为假。
func (c configuration) claudeInbox() (enabled, written bool) {
	raw, written := c.settings.lookup(claudeInboxKey)
	if !written || json.Unmarshal(raw, &enabled) != nil {
		return false, false
	}
	return enabled, true
}

// 设置里没写过时算开还是关：看更低几层（设置里的环境变量表、启动服务的环境、环境文件）把变量设成了什么，
// 只有明说 off 的算关，和运行时实际的一致。
func (c configuration) defaultClaudeInbox() bool {
	entry := c
	entry.harness, entry.settingsEnv = claudeHarness, c.environmentTable(claudeHarness)
	return !strings.EqualFold(strings.TrimSpace(entry.environmentValue(claudeInboxVariable)), "off")
}

func claudeInboxSetting(c configuration, group string) settingSpec {
	return settingSpec{
		Key: claudeInboxKey, Group: group, Type: settingBoolean, Scope: harnessScope(claudeHarness), Restart: restartHarness,
		Default: c.defaultClaudeInbox(), Title: both("接收别的 Claude 会话的消息", "Messages from other Claude sessions"),
		Description: both(
			"开着时，这台设备上别的 Claude 会话（Claude 桌面端、终端里的 Claude Code、Litch 里别的 Claude 会话）可以用 SendMessage 给这里的会话发消息，"+
				"会话收到后会自己开一个回合处理，对话里显示是谁发来的。对方的请求按收到消息的会话自己的权限执行：完全访问的会话不会再问你。"+
				"只在会话的 Claude Code 进程还开着时收得到。关掉之后这里的会话不出现在别的会话的列表里，也收不到。改了之后 Claude Code 重启才生效。",
			"While on, other Claude sessions on this device (the Claude desktop app, Claude Code in a terminal, other Claude sessions in Litch) can message sessions here with SendMessage; "+
				"the session starts a turn to handle it, and the conversation shows who sent it. The request runs with the receiving session's own permissions: a full-access session will not ask you. "+
				"Messages arrive only while the session's Claude Code process is running. When off, sessions here are not listed to other sessions and receive nothing. Takes effect after Claude Code restarts.",
		),
	}
}
