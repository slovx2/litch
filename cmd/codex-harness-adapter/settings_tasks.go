package main

// 定时任务（协议扩展 deviceTasks）的两项设置：总开关、整台设备同时在跑的上限。
// 任务本身和调度都在设备进程里（packages/device/src/tasks.mts），这一层只管设置。
// 怎么生效：和可重连的终端那几项一样（settings_processes.go），设置改了不重启设备进程，
// 经控制通道把现行值推过去（controlState.Tasks），设备进程当场换上。

const (
	taskGroup         = "tasks"
	taskEnabledKey    = "tasks.enabled"
	taskConcurrentKey = "tasks.maxConcurrent"
	// 和设备进程自己的默认值（DEFAULT_TASK_SETTINGS）一样。
	taskConcurrentDefault = 2
	taskConcurrentMinimum = 1
	taskConcurrentMaximum = 16
)

func taskSettings() (settingGroup, []settingSpec) {
	description := both(
		"定时任务存在这台设备上，到点由设备服务自己去跑，客户端断开、桌面端退出都照样跑。下面两项改了立刻生效，不用重启任何东西。",
		"Scheduled tasks live on this device and the device service runs them on time, even when no client is connected or the desktop app has quit. Changes below take effect at once and restart nothing.",
	)
	minimum, maximum := taskConcurrentMinimum, taskConcurrentMaximum
	return settingGroup{
			ID: taskGroup, Scope: deviceScope, Description: &description,
			Title: both("定时任务", "Scheduled tasks"),
		}, []settingSpec{
			{
				Key: taskEnabledKey, Group: taskGroup, Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
				Default: true, Title: both("按日程运行", "Run on schedule"),
				Description: both(
					"关掉后任务不再按日程触发；已经在跑的、手动立即运行的照常跑。再打开时，关着期间错过的时间点不补跑，从那一刻往后算（一次性的任务除外，照常补跑一次）。",
					"While off, tasks are not triggered by their schedules; runs already going and runs started by hand still happen. When turned back on, times missed while off are not made up; schedules continue from then (one-time tasks still run once).",
				),
			},
			{
				Key: taskConcurrentKey, Group: taskGroup, Type: settingInteger, Scope: deviceScope, Restart: restartNone,
				Default: taskConcurrentDefault, Minimum: &minimum, Maximum: &maximum,
				Title: both("同时运行的上限", "Runs at once"),
				Description: both(
					"整台设备上同时最多有这么多次任务运行在跑，多的排着，按计划时间先后开始。默认 2。调小不会打断已经在跑的。",
					"At most this many task runs go at once on this device; the rest wait and start in order of their scheduled time. Default 2. Lowering it never interrupts runs already going.",
				),
			},
		}
}

// 推给设备进程的现行值，键和设备进程那边 TaskSettings 的字段同名。
// 文件被手工改到范围之外的那一项按没写过算。
func (c configuration) taskSettings() map[string]any {
	limit := c.settings.integer(taskConcurrentKey, taskConcurrentDefault)
	if limit < taskConcurrentMinimum || limit > taskConcurrentMaximum {
		limit = taskConcurrentDefault
	}
	return map[string]any{
		"enabled":       c.settings.boolean(taskEnabledKey, true),
		"maxConcurrent": limit,
	}
}
