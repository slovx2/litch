package main

import (
	"encoding/json"
	"strconv"
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
	if strings.EqualFold(strings.TrimSpace(entry.environmentValue(claudeCacheTTLVariable)), claudeCacheTTLDefault) {
		return claudeCacheTTLDefault
	}
	return claudeCacheTTLHour
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
			"默认缓存 1 小时，减少长对话间隔后的重复写入；缓存写入单价更高（普通输入的 2 倍，5 分钟为 1.25 倍）。"+
				"选择跟官方一致时，订阅额度内主对话为 1 小时，额外付费用量、API key 和云平台为 5 分钟。子代理和后台请求仍用 5 分钟。修改后 Claude Code 重启才生效。",
			"Defaults to 1 hour, reducing repeated cache writes in long conversations, but each write costs more (2× normal input versus 1.25× for 5 minutes). "+
				"Same as Claude Code uses 1 hour within subscription plan usage and 5 minutes for usage credits, API keys and cloud providers. Subagents and background requests keep 5 minutes. Takes effect after Claude Code restarts.",
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
				"回合结束后，会话按“空闲会话保持在线”再留一阵，留着时也收得到。关掉之后这里的会话不出现在别的会话的列表里，也收不到。改了之后 Claude Code 重启才生效。",
			"While on, other Claude sessions on this device (the Claude desktop app, Claude Code in a terminal, other Claude sessions in Litch) can message sessions here with SendMessage; "+
				"the session starts a turn to handle it, and the conversation shows who sent it. The request runs with the receiving session's own permissions: a full-access session will not ask you. "+
				"After a turn ends, the session stays reachable for as long as “Keep idle sessions online” allows. When off, sessions here are not listed to other sessions and receive nothing. Takes effect after Claude Code restarts.",
		),
	}
}

// 空闲会话保持在线：回合结束、没有后台命令的 Claude Code 进程再留多久，留着的会话才收得到别的会话发来的消息。
// 落到运行时的 CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS（packages/claude/src/native-session.mts）；没设时运行时
// 开着收件箱就留 1 小时、关着就不留。收件箱关着时写了这一项也不给变量：不收消息就不为它多占内存。

const (
	claudeIdleKey      = "harness.claude-code.idleKeepAlive"
	claudeIdleVariable = "CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS"
)

// 各档对应的秒数，按从短到长排
var claudeIdleChoices = []struct {
	value   string
	seconds int
	title   bilingual
}{
	{"off", 0, both("关", "Off")},
	{"15m", 15 * 60, both("15 分钟", "15 minutes")},
	{"1h", 60 * 60, both("1 小时", "1 hour")},
	{"4h", 4 * 60 * 60, both("4 小时", "4 hours")},
}

// 设置里写过、认得的那一档的秒数；没写过或认不出时 written 为假。
func (c configuration) claudeIdle() (seconds int, written bool) {
	raw, written := c.settings.lookup(claudeIdleKey)
	var value string
	if !written || json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	for _, choice := range claudeIdleChoices {
		if choice.value == value {
			return choice.seconds, true
		}
	}
	return 0, false
}

// 收件箱实际开没开：写过按写的，没写过按更低几层
func (c configuration) claudeInboxOn() bool {
	if enabled, written := c.claudeInbox(); written {
		return enabled
	}
	return c.defaultClaudeInbox()
}

// 没写过时显示哪一档：更低几层设了秒数的取不超过它的最长一档，没设的是运行时的默认 1 小时。
func (c configuration) defaultClaudeIdle() string {
	entry := c
	entry.harness, entry.settingsEnv = claudeHarness, c.environmentTable(claudeHarness)
	raw := strings.TrimSpace(entry.environmentValue(claudeIdleVariable))
	if raw == "" {
		return "1h"
	}
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return "1h"
	}
	value := claudeIdleChoices[0].value
	for _, choice := range claudeIdleChoices {
		if float64(choice.seconds) <= seconds {
			value = choice.value
		}
	}
	return value
}

func claudeIdleSetting(c configuration, group string) settingSpec {
	options := make([]settingOption, 0, len(claudeIdleChoices))
	for _, choice := range claudeIdleChoices {
		options = append(options, settingOption{Value: choice.value, Title: choice.title})
	}
	return settingSpec{
		Key: claudeIdleKey, Group: group, Type: settingEnum, Scope: harnessScope(claudeHarness), Restart: restartHarness,
		Default: c.defaultClaudeIdle(), Title: both("空闲会话保持在线", "Keep idle sessions online"), Options: options,
		Description: both(
			"会话的回合结束后，它的 Claude Code 进程再留这么久，期间别的 Claude 会话发来的消息照样收得到，接着聊也不用重新启动。"+
				"每个留着的会话约占 100–200MB 内存，最多同时留 8 个（和看管后台命令的进程共用这个上限），满了先关闲得最久的。"+
				"只在开着“接收别的 Claude 会话的消息”时生效。改了之后 Claude Code 重启才生效。",
			"After a session's turn ends, its Claude Code process stays this long, so messages from other Claude sessions still arrive and the next turn needs no restart. "+
				"Each kept session uses about 100–200 MB of memory; at most 8 are kept at once (shared with processes keeping background commands), and the one idle longest closes first. "+
				"Applies only while “Messages from other Claude sessions” is on. Takes effect after Claude Code restarts.",
		),
	}
}

const claudeBackendKey = "harness.claude-code.backend"
const claudeBackendSettingsVariable = "CHA_CLAUDE_BACKEND_SETTINGS"

func claudeBackendSetting(group string) settingSpec {
	return settingSpec{
		Key: claudeBackendKey, Group: group, Type: settingEnum, Scope: harnessScope(claudeHarness), Restart: restartNone,
		Default: "sdk", Title: both("驱动后端", "Backend"),
		Options: []settingOption{{Value: "sdk", Title: both("SDK", "SDK")}, {Value: "tui", Title: both("TUI", "TUI")}},
		Description: both(
			"下一回合生效，已有会话沿用原生历史。TUI 需要 Claude Code 2.1.316 或更新版本；版本不足时，请在本页的安装与更新中选择“更新到最新”。TUI 暂不支持计划模式、子代理、后台任务、PowerShell 工具、插话、分叉、手动压缩和持续目标；切换前请先结束这些任务。",
			"Applies from the next turn, preserving existing session history. TUI requires Claude Code 2.1.316 or later; use Update to latest in installation settings. TUI does not yet support plan mode, subagents, background tasks, PowerShell tools, steering, forks, manual compaction or goals. Finish active tasks before switching.",
		),
	}
}
