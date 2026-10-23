package main

import "encoding/json"

// 注入的后台 shell（packages/shared/src/background-shell.mts）：给没有原生后台命令的 harness 一组 litch_shell 工具，
// 命令在回合结束后接着跑、跑完叫醒模型接着做。Claude Code、原生 codex、DeepSeek Harness 有自己的，Gemini CLI、
// Qwen Code 按用户的意思不带，所以只有这三个有这一项。开关落到环境变量上，运行时起来时读一次，改了要重启运行时。
const backgroundShellVariable = "CHA_BACKGROUND_SHELL"

// 设置里没写过、更低几层也没给变量时开不开：和 packages/shared/src/background-shell.mts 的 BACKGROUND_SHELL_DEFAULT 一致。
const backgroundShellDefault = false

var backgroundShellHarnesses = map[string]bool{"pi": true, "opencode": true, "acp": true}

func backgroundShellKey(id string) string { return "harness." + id + ".backgroundShell" }

// 写过才给变量：开是 1，关是 0，盖过更低几层里的同名变量。没写过就不给，由那几层（或运行时的默认）说了算。
func (c configuration) backgroundShellEnvironment(id string, values map[string]string) {
	if !backgroundShellHarnesses[id] {
		return
	}
	var on bool
	if raw, written := c.settings.lookup(backgroundShellKey(id)); written && json.Unmarshal(raw, &on) == nil {
		values[backgroundShellVariable] = map[bool]string{true: "1", false: "0"}[on]
	}
}

// 设置里没写过时它算开还是关：照运行时起来会拿到的那份环境（设置里的环境变量表、启动服务的环境、环境文件），
// 都没给就是运行时的默认。
func (c configuration) defaultBackgroundShell(id string) bool {
	entry := c
	entry.harness, entry.settingsEnv = id, c.environmentTable(id)
	switch entry.environmentValue(backgroundShellVariable) {
	case "1":
		return true
	case "0":
		return false
	}
	return backgroundShellDefault
}

// 进运行时指纹的那一项：改了它运行时要重启
func (c configuration) backgroundShellFingerprint(id string) string {
	if !backgroundShellHarnesses[id] {
		return ""
	}
	raw, _ := c.settings.lookup(backgroundShellKey(id))
	return string(raw)
}

func backgroundShellSetting(c configuration, id, group string) settingSpec {
	return settingSpec{
		Key: backgroundShellKey(id), Group: group, Type: settingBoolean, Scope: harnessScope(id), Restart: restartHarness,
		Default: c.defaultBackgroundShell(id), Title: both("后台命令", "Background commands"),
		Description: both(
			"开着时给模型一组后台命令工具：开发服务器、监听、长时间的构建或脚本可以在回合结束后接着跑，界面上列出在跑的，"+
				"命令自己跑完时模型被叫醒接着做；你也可以在后台任务里停掉它们。命令跑在这台设备上，和模型自己跑命令一样；"+
				"改设置、重启服务时还在跑的会被停掉。改了要重启这个 harness 的运行时。",
			"While on, the model gets background command tools: dev servers, watchers, long builds or scripts keep running after the turn ends, the app lists the running ones, "+
				"and the model is woken to continue when a command finishes on its own; you can stop them from the background tasks list. Commands run on this device, the same as the model's own commands; "+
				"commands still running are stopped when settings change or the service restarts. Changing this restarts this harness's runtime.",
		),
	}
}
