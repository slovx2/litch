package main

import "strconv"

// 属于设备的进程（可重连的终端，协议扩展 deviceProcesses）的四个上限和期限。
// 它们是设备进程的启动参数（packages/device/src/args.mts）。这张表是它们在这一层唯一写着的地方：
// 设置里的声明、拉起设备进程时带的参数、经控制通道推给它的现行值，都从这里来。
//
// 怎么生效：设备进程不能为了换这几个数重启——它一重启，正在跑的终端和所有客户端连接都没了。
// 所以除了拉起时带上现行值，设置改了之后还经控制通道把新值推过去，设备进程当场换上，只管之后的事
// （见 packages/device/src/device-processes.mts 的 setLimits）。
type processOption struct {
	// 设置项的键。
	key string
	// 设备进程的启动参数。
	flag string
	// 推给设备进程时用的名字，和它那边 ProcessLimits 的字段同名。
	field string
	// 默认值和设备进程自己的默认值（DEFAULT_PROCESS_LIMITS）一样；设备包的端到端测试守着两边一致。
	fallback int
	// 取值范围，都落在设备进程的启动参数肯收的范围之内。
	minimum, maximum int
	title, text      bilingual
}

// 定时器能等的最长时间（毫秒），设备进程的启动参数以它为上限。
const maximumTimerMilliseconds = 2147483647

var processOptions = []processOption{
	{
		key: "processes.bufferBytes", flag: "--process-buffer-bytes", field: "bufferBytes",
		// 下限取设备进程发一帧输出的大小（64 KiB，device-processes.mts 的 FRAME_BYTES）：留的比一帧还少没有实际意义。
		fallback: 2 * 1024 * 1024, minimum: 64 * 1024, maximum: 1024 * 1024 * 1024,
		title: both("每个终端保留的输出（字节）", "Output kept per terminal (bytes)"),
		text: both(
			"每个终端留着末尾这么多字节的输出，重新连上时补回来；更早的丢掉。默认 2097152（2 MiB）。改了之后只管之后新开的终端，已经在跑的照原来的大小。",
			"Each terminal keeps this many bytes at the end of its output and replays them when you reconnect; anything earlier is dropped. Default 2097152 (2 MiB). A change applies to terminals opened afterwards; running ones keep their size.",
		),
	},
	{
		key: "processes.limit", flag: "--process-limit", field: "maxProcesses",
		fallback: 32, minimum: 1, maximum: 4096,
		title: both("同时运行的终端上限", "Terminals running at once"),
		text: both(
			"这台设备上同时最多有这么多个可重连的终端在跑，到了上限就开不了新的。默认 32。调小不会结束已经在跑的。",
			"At most this many reconnectable terminals run on this device at once; beyond that no new one can be opened. Default 32. Lowering it never ends terminals that are already running.",
		),
	},
	{
		key: "processes.idleMs", flag: "--process-idle-ms", field: "idleTimeoutMs",
		fallback: 0, minimum: 0, maximum: maximumTimerMilliseconds,
		title: both("没人挂接时保留多久（毫秒）", "Keep unattended terminals for (ms)"),
		text: both(
			"一个终端没有任何客户端挂着超过这么久，就结束它和里面的进程。0 是一直留着（默认）。改了之后，这时没人挂着的终端从改的那一刻起重新计时。",
			"A terminal that no client has been attached to for this long is ended together with its processes. 0 keeps it forever (default). After a change, terminals that are unattended at that moment start counting again from then.",
		),
	},
	{
		key: "processes.exitedMs", flag: "--process-exited-ms", field: "exitedRetentionMs",
		fallback: 10 * 60 * 1000, minimum: 0, maximum: maximumTimerMilliseconds,
		title: both("退出后的记录保留多久（毫秒）", "Keep exited terminals for (ms)"),
		text: both(
			"终端退出之后，它的退出状态和末尾的输出再留这么久，之后清掉。默认 600000（10 分钟）。改了之后只管之后退出的终端。",
			"After a terminal exits, its exit status and the end of its output are kept this long, then cleared. Default 600000 (10 minutes). A change applies to terminals that exit afterwards.",
		),
	},
}

const processGroup = "processes"

func processSettings() (settingGroup, []settingSpec) {
	description := both(
		"终端可以属于这台设备：客户端断开后它接着跑，重新连上再挂回去，并补上断开期间的输出。下面几项改了立刻生效，不用重启任何东西，也不会结束正在跑的终端。",
		"A terminal can belong to this device: it keeps running after the client disconnects, and you attach to it again on reconnect, with the output you missed replayed. Changes below take effect at once, restart nothing, and never end a running terminal.",
	)
	group := settingGroup{
		ID: processGroup, Scope: deviceScope, Description: &description,
		Title: both("可重连的终端", "Reconnectable terminals"),
	}
	specs := make([]settingSpec, 0, len(processOptions))
	for _, option := range processOptions {
		minimum, maximum := option.minimum, option.maximum
		specs = append(specs, settingSpec{
			Key: option.key, Group: processGroup, Type: settingInteger, Scope: deviceScope, Restart: restartNone,
			Default: option.fallback, Minimum: &minimum, Maximum: &maximum, Title: option.title, Description: option.text,
		})
	}
	return group, specs
}

// 四项的现行值，键是 processOption.field。设置里没写过的用默认值；
// 文件被手工改到范围之外的那一项也按没写过算：带着它设备进程会拒收参数，聚合面就起不来了。
func (c configuration) processLimits() map[string]int {
	limits := make(map[string]int, len(processOptions))
	for _, option := range processOptions {
		value := c.settings.integer(option.key, option.fallback)
		if value < option.minimum || value > option.maximum {
			value = option.fallback
		}
		limits[option.field] = value
	}
	return limits
}

// 拉起设备进程时带的那几个参数，按表里的次序。
func (c configuration) processArguments() []string {
	limits := c.processLimits()
	args := make([]string, 0, 2*len(processOptions))
	for _, option := range processOptions {
		args = append(args, option.flag, strconv.Itoa(limits[option.field]))
	}
	return args
}
