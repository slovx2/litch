package main

// 会话编排（协议扩展 sessionTree，protocol/extensions/session-tree.json）的开关。
// 一个会话派出子会话、模型用 litch_sessions 列出读取别的会话、子会话的回报和唤醒父会话，都由设备进程做
// （packages/device/src/session-tree.mts）。设备进程从经控制通道推过去的设置现状里按 sessionTreeKey 读它
// （device.mts 的 SESSION_TREE_SETTING），改了当场生效，不重启任何东西：关掉时设备信息不列 sessionTree，
// 新会话不带 litch_sessions，不回报、不唤醒；已有的父子关系还在设备进程的库里，照常显示。

const sessionTreeKey = "sessions.enabled"

const sessionGroup = "sessions"

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
	return group, []settingSpec{spec}
}
