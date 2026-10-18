package main

// machine 子命令（短名 litch-machine）：让这台机器上任何能跑 shell 的 harness 操作用户的 Litch 桌面端那台电脑，
// 不支持动态工具的 harness 靠它。动作和工具 litch_machine 一一对应（packages/protocol/src/client-tools-machine.mts）：
// machines、exec、ps（process）、read（read_file）、write（write_file）、ls（list_dir）、cp（copy）。
// 请求经本机的设备服务转给连着的 Litch，审批和执行都在桌面端；这里只管参数、转交和把结果打出来。

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 短名。装在适配器的命令旁边，是指向它的链接；按调用时的名字认出来（main.go）
const machineShortName = "litch-machine"

const machineNamespace = "litch_machine"

// 命令从哪个会话里跑出来的，按先后认这几个环境变量：
// LITCH_THREAD_ID 是 Claude Code 入口给它起的 CLI 的；CODEX_THREAD_ID 是原生 codex 给每条命令的；
// Pi、dsh 的入口里会话号就是它们自己的会话号，它们给命令的 PI_SESSION_ID、DSH_SESSION_ID 拿来就能用。
// 这几个变量只对起它的那个会话有意义：命令行起运行时和设备进程时不把外面带进来的传下去（environment、serviceEnvironment）。
var machineThreadVariables = []string{"LITCH_THREAD_ID", "CODEX_THREAD_ID", "PI_SESSION_ID", "DSH_SESSION_ID"}

func isMachineThreadVariable(name string) bool {
	for _, known := range machineThreadVariables {
		if name == known {
			return true
		}
	}
	return false
}

// 退出码。exec 成功拿到结果时是命令自己的退出码，下面这些只在没拿到结果时用（照 sysexits 的取值，少和命令撞）
const (
	machineExitUsage       = 64 // 参数不对（这边查出来的，或者桌面端说参数不对：invalid）
	machineExitUnreachable = 69 // 连不上本机的设备服务
	machineExitFailed      = 70 // 桌面端执行出错、超时、被打断（failed），别的说不清的错误
	machineExitPermission  = 71 // 桌面端缺系统权限（permission）
	machineExitNoDesktop   = 75 // 没有 Litch 桌面端连着这台设备（noExecutor）
	machineExitAmbiguous   = 76 // 连着不止一台 Litch，不知道交给哪台（ambiguous）
	machineExitDeclined    = 77 // 用户在桌面端拒绝了，或者没有答复（declined）
	machineExitDisabled    = 78 // 桌面端的设备设置里没打开“操作这台电脑”（disabled）
	machineExitBlocked     = 79 // 访问范围挡住了（blocked）
	machineExitRunning     = 80 // exec 到了 --yield-ms 还没结束，进程留着
)

// 动作名到工具名
var machineTools = map[string]string{
	"machines": "machines",
	"exec":     "exec",
	"ps":       "process",
	"read":     "read_file",
	"write":    "write_file",
	"ls":       "list_dir",
	"cp":       "copy",
}

// 一次 machine 调用要做的事
type machineCommand struct {
	action  string
	tool    string
	args    map[string]any
	json    bool
	help    bool
	desktop string
	thread  string
	socket  string
}

// 参数不对（退出码 64）
type machineUsageError struct{ message string }

func (e *machineUsageError) Error() string { return e.message }

func usageErr(zh, en string, args ...any) error {
	return &machineUsageError{message: fmt.Sprintf(tr(zh, en), args...)}
}

// 各动作认的选项：值是“要不要跟一个值”
var machineFlags = map[string]map[string]bool{
	"machines": {},
	"exec":     {"cwd": true, "timeout-ms": true, "yield-ms": true, "stdin": true, "machine": true},
	"ps":       {"input": true, "signal": true, "wait-ms": true, "after-seq": true},
	"read":     {"offset": true, "length": true, "machine": true},
	"write":    {"mode": true, "content": true, "machine": true},
	"ls":       {"depth": true, "machine": true},
	"cp":       {},
}

// 每个动作都认的选项
var machineCommonFlags = map[string]bool{"json": false, "help": false, "h": false, "desktop": true, "thread": true, "home": true}

// parseMachineArgs 解析 machine 之后的参数。选项可以放在位置参数前后，`--` 之后的都是位置参数。
// env 取环境变量（会话号、套接字的位置），stdin 是 `--stdin -`、write 没给 --content 时读的。
func parseMachineArgs(argv []string, env func(string) string, stdin io.Reader) (machineCommand, error) {
	command := machineCommand{args: map[string]any{}}
	if len(argv) == 0 || argv[0] == "--help" || argv[0] == "-h" || argv[0] == "help" {
		command.help = true
		return command, nil
	}
	command.action = argv[0]
	tool, known := machineTools[command.action]
	if !known {
		return command, usageErr("不认识的动作 %q；可用的：machines、exec、ps、read、write、ls、cp", "unknown action %q; use one of machines, exec, ps, read, write, ls, cp", command.action)
	}
	command.tool = tool
	values := map[string]string{}
	var positional []string
	rest := argv[1:]
	for index := 0; index < len(rest); index++ {
		arg := rest[index]
		if arg == "--" {
			positional = append(positional, rest[index+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			// exec 的命令从第一个位置参数起到最后（和 ssh 一样），里面像选项的不再当选项
			if command.action == "exec" {
				positional = append(positional, rest[index:]...)
				break
			}
			positional = append(positional, arg)
			continue
		}
		name, value, inline := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		takes, ok := machineFlags[command.action][name]
		if !ok {
			takes, ok = machineCommonFlags[name]
		}
		if !ok {
			return command, usageErr("%s 不认识选项 %s", "%s does not take the option %s", command.action, arg)
		}
		if !takes {
			if inline {
				return command, usageErr("选项 %s 不带值", "the option %s takes no value", "--"+name)
			}
			values[name] = "true"
			continue
		}
		if !inline {
			if index+1 >= len(rest) {
				return command, usageErr("选项 %s 要跟一个值", "the option %s needs a value", "--"+name)
			}
			index++
			value = rest[index]
		}
		values[name] = value
	}
	command.json = values["json"] == "true"
	command.help = values["help"] == "true" || values["h"] == "true"
	if command.help {
		return command, nil
	}
	command.desktop = values["desktop"]
	command.thread = values["thread"]
	if command.thread == "" {
		command.thread = firstNonEmpty(env(machineThreadVariables[0]), env(machineThreadVariables[1]),
			env(machineThreadVariables[2]), env(machineThreadVariables[3]))
	}
	command.socket = machineSocket(values["home"], env)
	if err := fillMachineArgs(&command, values, positional, stdin); err != nil {
		return command, err
	}
	return command, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// 设备服务的套接字：--home 给了用它；不然用适配器交给运行时的 LITCH_DEVICE_SOCKET（harness 跑的命令继承得到）；
// 都没有是默认的状态目录。
func machineSocket(home string, env func(string) string) string {
	if home == "" {
		if socket := env(deviceSocketEnvironment); socket != "" {
			return socket
		}
		base, err := os.UserHomeDir()
		if err != nil {
			base = "."
		}
		home = filepath.Join(base, ".codex-harness-adapter")
	}
	if absolute, err := filepath.Abs(home); err == nil {
		home = absolute
	}
	return hostplatform.DeviceSocketPath(filepath.Join(home, "device"))
}

func machineInt(values map[string]string, name, key string, args map[string]any) error {
	raw, given := values[name]
	if !given {
		return nil
	}
	number, err := strconv.Atoi(raw)
	if err != nil || number < 0 {
		return usageErr("--%s 要一个不小于 0 的整数", "--%s needs a whole number, 0 or more", name)
	}
	args[key] = number
	return nil
}

func machineText(values map[string]string, name, key string, args map[string]any, stdin io.Reader) error {
	value, given := values[name]
	if !given {
		return nil
	}
	if value == "-" {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return err
		}
		value = string(data)
	}
	args[key] = value
	return nil
}
