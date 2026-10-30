package main

// 会话编排（协议扩展 sessionTree，protocol/extensions/session-tree.json）的开关。
// 一个会话派出子会话、模型用 litch_sessions 列出读取别的会话、子会话的回报和唤醒父会话，都由设备进程做
// （packages/device/src/session-tree.mts）。设备进程从经控制通道推过去的设置现状里按 sessionTreeKey 读它
// （device.mts 的 SESSION_TREE_SETTING），改了当场生效，不重启任何东西：关掉时设备信息不列 sessionTree，
// 新会话不带 litch_sessions，不回报、不唤醒；已有的父子关系还在设备进程的库里，照常显示。

const sessionTreeKey = "sessions.enabled"

// 每回合收尾：开着时新会话的 litch_sessions 带 wrap_up，规则要求模型每回合干完活先调它（建议任务放在参数里）、再写最终回答。
// 设备进程按 wrapUpKey 读（device.mts 的 WRAP_UP_SETTING），建会话时按它换掉客户端给的那组工具，所以只对之后新建的会话生效；
// 提醒跟着它当场停。关掉时规则里不提收尾，建议改用 start 的 propose，会话编排的其余能力照常。
const wrapUpKey = "sessions.wrapUp"

// 提醒收尾：用户发起的回合结束时模型没调 litch_sessions.wrap_up，设备进程替它再开一个回合提醒（一条用户消息之后最多一次）。
// 设备进程按 wrapUpReminderKey 读（device.mts 的 WRAP_UP_REMINDER_SETTING），改了当场生效；关掉之后 wrap_up 照常能用。
// 每回合收尾关着时它不起作用。
const wrapUpReminderKey = "sessions.wrapUpReminder"

const sessionGroup = "sessions"

// 任务卡按 harness 的开关（作用域 harness，放在各 harness 自己那一组里）：关着时这个 harness 上的会话没有建议任务卡片、
// “新会话 / 在这里做”的卡和收尾，也不提醒；派子会话、交接这些照旧。设备进程按 taskCardsKey 读
// （packages/protocol/src/session-tree.mts 的 taskCardsSettingKey），新会话建的时候挑那组工具，已有会话当场生效。
func taskCardsKey(id string) string { return "harness." + id + ".taskCards" }

func taskCardsSetting(id, group string) settingSpec {
	return settingSpec{
		Key: taskCardsKey(id), Group: group, Type: settingBoolean, Scope: harnessScope(id), Restart: restartNone,
		Default: true, Title: both("任务卡", "Task cards"),
		Description: both(
			"开着时模型会把值得另开会话的后续工作做成建议任务卡片，和这个会话无关的新任务先出“新会话 / 在这里做”的卡，每回合收尾。关掉之后这个 harness 的会话不再出这些卡、不收尾也不提醒；你明说要时它照样派子会话、交接任务。立刻生效，已有会话也一样。会话编排关着时这一项不起作用。",
			"While on, the model turns follow-up work worth its own session into suggested-task cards, asks with a \"New session / Do it here\" card before a new task unrelated to the session, and wraps up every turn. When off, sessions of this harness get none of these cards, no wrap-up and no reminder; the model still starts sub-sessions and hands off tasks when you ask. Takes effect at once, also in existing sessions. Has no effect while Session orchestration is off.",
		),
	}
}

func sessionSettings() (settingGroup, []settingSpec) {
	description := both(
		"一个会话可以派出子会话（任意 harness，同一台设备），子会话的结果回到主会话。",
		"A session can start sub-sessions on this device (any harness), and their results come back to it.",
	)
	group := settingGroup{
		ID: sessionGroup, Scope: deviceScope, Description: &description,
		Title: both("会话编排", "Session orchestration"),
	}
	spec := settingSpec{
		Key: sessionTreeKey, Group: sessionGroup, Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
		Default: true, Title: both("会话编排", "Session orchestration"),
		Description: both(
			"开着时模型可以用 litch_sessions 列出、读取这台设备上的会话，派子会话（用户没要求的先出提案卡片），给自己的子会话发消息；子会话做完一回合把结果交回主会话，必要时唤醒它。关掉之后新建的会话不带这组工具，不再回报、唤醒；已有的父子关系照常显示。立刻生效。",
			"While on, the model can use litch_sessions to list and read sessions on this device, start sub-sessions (as a proposal card unless the user asked for one), and message its own sub-sessions; a sub-session hands each turn's result back and can wake its parent. When off, new sessions do not get these tools and nothing is reported or woken; existing parent links still show. Takes effect at once.",
		),
	}
	wrapUp := settingSpec{
		Key: wrapUpKey, Group: sessionGroup, Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
		Default: true, Title: both("每回合收尾", "Wrap up every turn"),
		Description: both(
			"开着时模型每回合干完活先调 litch_sessions.wrap_up，把值得另开会话的后续工作作为建议任务卡片交给你（没有建议也要调），再写给你的最终回答。关掉之后模型不再收尾，规则里也不要求，只在它自己觉得有必要时用提案卡片建议；派子会话、提案、开新会话这些照常。开关只对之后新建的会话生效：已有会话照建的时候的工具和规则，只是关掉后不再提醒。",
			"While on, the model ends every turn by calling litch_sessions.wrap_up once its work is done, handing you follow-up work worth its own session as suggested-task cards (it calls it even with nothing to suggest), and then writes its final answer. When off, the model does not wrap up and is not asked to; it suggests work with proposal cards only when it sees fit, and sub-sessions, proposals and new-session offers work as before. Applies to sessions created afterwards: existing sessions keep the tools and rules they started with, except that reminders stop once this is off.",
		),
	}
	reminder := settingSpec{
		Key: wrapUpReminderKey, Group: sessionGroup, Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
		Default: true, Title: both("提醒收尾", "Wrap-up reminder"),
		Description: both(
			"每回合收尾开着时，模型每回合都要调 litch_sessions.wrap_up。开着这一项时，你发的消息那一回合结束了模型还没调，Litch 会替它再开一个回合提醒一次（多花一点 token）。关掉之后不提醒，模型照样可以调。每回合收尾关着时这一项不起作用。立刻生效。",
			"While Wrap up every turn is on, the model should call litch_sessions.wrap_up in every turn. While this is on, if a turn you started ends without it, Litch opens one more turn to remind the model (a few extra tokens). When off, there is no reminder; the model can still call it. Has no effect while Wrap up every turn is off. Takes effect at once.",
		),
	}
	retention := settingSpec{
		Key: "sessions.suggestionRetentionDays", Group: sessionGroup, Type: settingEnum, Scope: deviceScope, Restart: restartNone,
		Default: "7", Title: both("建议保留时间", "Suggestion retention"),
		Description: both("按创建时间重新计算待处理建议的期限；缩短后，已超期的建议立即过期。", "Recalculates pending suggestions from their creation time. Shortening retention expires older suggestions immediately."),
		Options: []settingOption{
			{Value: "1", Title: both("1 天", "1 day")},
			{Value: "3", Title: both("3 天", "3 days")},
			{Value: "7", Title: both("7 天", "7 days")},
			{Value: "14", Title: both("14 天", "14 days")},
			{Value: "30", Title: both("30 天", "30 days")},
			{Value: "never", Title: both("不过期", "Never")},
		},
	}
	return group, []settingSpec{spec, wrapUp, reminder, retention}
}
