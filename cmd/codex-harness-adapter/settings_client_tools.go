package main

import "encoding/json"

// 常驻工具的开关存会话所在设备；执行器是否在线只在调用时判断。
func clientToolKey(column, harness string) string {
	if harness == "" {
		return "tools." + column
	}
	return "harness." + harness + "." + column
}

func (c configuration) clientToolSettings(harness, group string) []settingSpec {
	scope := deviceScope
	if harness != "" {
		scope = harnessScope(harness)
	}
	var specs []settingSpec
	if harness == "" {
		specs = append(specs, settingSpec{
			Key: "tools.machine", Group: group, Type: settingBoolean, Scope: deviceScope,
			Restart: restartNone, Default: false, Title: both("操作这台电脑", "Operate this computer"),
			Description: both("允许会话通过连接的 Litch 桌面端操作命令与文件。", "Allow sessions to operate commands and files through a connected Litch desktop."),
		})
	}
	for _, column := range []string{"browser", "computer"} {
		fallback := column == "browser"

		title := both("内置浏览器", "Built-in browser")
		if column == "computer" {
			title = both("Computer Use", "Computer Use")
		}
		specs = append(specs, settingSpec{
			Key: clientToolKey(column, harness), Group: group, Type: settingBoolean,
			Scope: scope, Restart: restartNone, Default: fallback, Title: title,
			Description: both("新会话获得对应工具，调用时需要连接 Litch 桌面端。", "New sessions receive these tools. Calls require a connected Litch desktop."),
		})
	}
	return specs
}

// schema 会缓存；每次读快照时按当前设备值计算未单独设置的 harness，不能把继承值写入磁盘。
func inheritClientToolSettings(values map[string]any, explicit []string) {
	written := map[string]bool{}
	for _, key := range explicit {
		written[key] = true
	}
	for _, column := range []string{"browser", "computer"} {
		for _, harness := range knownHarnesses {
			key := clientToolKey(column, harness)
			if _, exists := values[key]; exists && !written[key] {
				values[key] = values[clientToolKey(column, "")]
			}
		}
	}
}

// 结构会缓存，但“恢复默认”展示的 harness 默认值必须跟随设备当前值。
func (c configuration) clientToolDefaults(schema settingsSchema) settingsSchema {
	schema.Settings = append([]settingSpec(nil), schema.Settings...)
	defaults := map[string]bool{}
	for _, column := range []string{"browser", "computer"} {
		value := column == "browser"
		if raw, written := c.settings.lookup(clientToolKey(column, "")); written {
			_ = json.Unmarshal(raw, &value)
		}
		for _, harness := range knownHarnesses {
			defaults[clientToolKey(column, harness)] = value
		}
	}
	for index, spec := range schema.Settings {
		if value, found := defaults[spec.Key]; found {
			schema.Settings[index].Default = value
		}
	}
	return schema
}
