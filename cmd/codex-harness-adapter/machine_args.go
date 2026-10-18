package main

// machine 各动作的位置参数和选项，换成工具 litch_machine 的参数（名字照 client-tools-machine.mts）。

import (
	"io"
	"strings"
)

func fillMachineArgs(command *machineCommand, values map[string]string, positional []string, stdin io.Reader) error {
	args := command.args
	if machine := values["machine"]; machine != "" {
		args["machine"] = machine
	}
	want := func(count int, zh, en string) error {
		if len(positional) < count {
			return usageErr("%s 缺参数：%s", "%s is missing %s", command.action, tr(zh, en))
		}
		if len(positional) > count {
			return usageErr("%s 多了参数：%s", "%s got extra arguments: %s", command.action, strings.Join(positional[count:], " "))
		}
		return nil
	}
	switch command.action {
	case "machines":
		return want(0, "", "")
	case "exec":
		if len(positional) == 0 {
			return usageErr("exec 缺参数：要执行的命令", "exec is missing the command to run")
		}
		// 几段拼成一行交给登录 shell 的 -lc（和 ssh 一样）；带空格、引号的命令整个用引号括起来最稳
		args["command"] = strings.Join(positional, " ")
		if cwd := values["cwd"]; cwd != "" {
			args["cwd"] = cwd
		}
		if err := machineInt(values, "timeout-ms", "timeout_ms", args); err != nil {
			return err
		}
		if err := machineInt(values, "yield-ms", "yield_ms", args); err != nil {
			return err
		}
		return machineText(values, "stdin", "stdin", args, stdin)
	case "ps":
		if len(positional) == 1 {
			positional = append(positional, "read")
		}
		if err := want(2, "进程号", "the process id"); err != nil {
			return err
		}
		args["process_id"] = positional[0]
		switch positional[1] {
		case "read", "write", "signal", "kill":
			args["action"] = positional[1]
		default:
			return usageErr("ps 的第二个参数只能是 read、write、signal、kill", "the second argument of ps must be read, write, signal or kill")
		}
		if signal := values["signal"]; signal != "" {
			signal = strings.ToUpper(signal)
			if !strings.HasPrefix(signal, "SIG") {
				signal = "SIG" + signal
			}
			args["signal"] = signal
		}
		if err := machineInt(values, "wait-ms", "wait_ms", args); err != nil {
			return err
		}
		if err := machineInt(values, "after-seq", "after_seq", args); err != nil {
			return err
		}
		if err := machineText(values, "input", "input", args, stdin); err != nil {
			return err
		}
		if args["action"] == "write" && args["input"] == nil {
			return usageErr("ps … write 要用 --input 给写进去的内容（--input - 读标准输入）", "ps … write needs --input with what to write (--input - reads stdin)")
		}
		return nil
	case "read":
		if err := want(1, "路径", "the path"); err != nil {
			return err
		}
		args["path"] = positional[0]
		if err := machineInt(values, "offset", "offset", args); err != nil {
			return err
		}
		return machineInt(values, "length", "length", args)
	case "write":
		if err := want(1, "路径", "the path"); err != nil {
			return err
		}
		args["path"] = positional[0]
		if mode := values["mode"]; mode != "" {
			if mode != "create" && mode != "overwrite" && mode != "append" {
				return usageErr("--mode 只能是 create、overwrite、append", "--mode must be create, overwrite or append")
			}
			args["mode"] = mode
		}
		if _, given := values["content"]; !given {
			// 没给 --content 就从标准输入读全部内容
			values["content"] = "-"
		}
		return machineText(values, "content", "content", args, stdin)
	case "ls":
		if err := want(1, "路径", "the path"); err != nil {
			return err
		}
		args["path"] = positional[0]
		return machineInt(values, "depth", "depth", args)
	case "cp":
		if err := want(2, "来源和去处（机器:路径）", "the source and the destination (machine:path)"); err != nil {
			return err
		}
		for index, key := range []string{"from", "to"} {
			machine, path, ok := splitMachinePath(positional[index])
			if !ok {
				return usageErr("cp 的参数要写成 机器:路径，机器是 session（这台）或 desktop（桌面端），比如 session:/tmp/a.txt：%s", "cp takes machine:path, where machine is session (this one) or desktop (the user's desktop), e.g. session:/tmp/a.txt: %s", positional[index])
			}
			args[key] = map[string]any{"machine": machine, "path": path}
		}
	}
	return nil
}

// "desktop:~/a.txt" → desktop、~/a.txt。机器名里不能有斜杠，路径不能是空的
func splitMachinePath(text string) (string, string, bool) {
	machine, path, found := strings.Cut(text, ":")
	if !found || machine == "" || path == "" || strings.ContainsAny(machine, `/\`) {
		return "", "", false
	}
	return machine, path, true
}
