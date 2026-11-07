package main

// 工具图片的开关在设备侧生效，控制存储和 UI 传输，不改变模型收到的工具结果。
func mediaSettings() (settingGroup, []settingSpec) {
	return settingGroup{ID: "privacy", Title: both("隐私", "Privacy"), Scope: deviceScope}, []settingSpec{{
		Key: "privacy.toolImages", Group: "privacy", Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
		Default: true, Title: both("在对话里显示 AI 读取的图片", "Show images read by AI in conversations"),
		Description: both("关闭后不保存、传输或显示工具图片。已保存的图片最多保留 30 天，设备缓存上限 512 MiB；不影响模型读取图片。", "When off, tool images are not saved, transferred or displayed. Previously saved images are retained for up to 30 days, within a 512 MiB device cache. This does not change images sent to the model."),
	}}
}
