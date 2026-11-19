package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func runDeviceChrome(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Println(tr(
			"用法：codex-harness-adapter chrome prepare|status|enable|disable|unprepare [--home <目录>] [准备时可选 --user-data-dir <Chrome 数据目录>]",
			"Usage: codex-harness-adapter chrome prepare|status|enable|disable|unprepare [--home <directory>] [prepare only: --user-data-dir <Chrome data directory>]",
		))
		fmt.Println(tr(
			"网站许可：chrome sites|trust-on|trust-off 或 chrome block|unblock|forget <网站> [--home <目录>]",
			"Website access: chrome sites|trust-on|trust-off or chrome block|unblock|forget <website> [--home <directory>]",
		))
		return nil
	}
	if runtime.GOOS != "linux" {
		return errors.New(tr("设备 Chrome 只支持 Linux。", "Device Chrome is available on Linux."))
	}
	action := args[0]
	switch action {
	case "prepare", "status", "enable", "disable", "unprepare", "sites", "trust-on", "trust-off", "block", "unblock", "forget":
	default:
		return fmt.Errorf(tr("未知的 Chrome 命令：%s", "Unknown Chrome command: %s"), action)
	}
	site := ""
	if action == "block" || action == "unblock" || action == "forget" {
		if len(args) < 2 || args[1] == "" || args[1][0] == '-' {
			return errors.New(tr("需要网站域名或来源。", "Specify a website host or origin."))
		}
		site = args[1]
		args = append([]string{action}, args[2:]...)
	}
	rest := make([]string, 0, len(args)-1)
	dataDir := ""
	for i := 1; i < len(args); i++ {
		if args[i] != "--user-data-dir" {
			rest = append(rest, args[i])
			continue
		}
		if action != "prepare" || dataDir != "" || i+1 >= len(args) || !filepath.IsAbs(args[i+1]) {
			return errors.New(tr("--user-data-dir 只用于准备命令，必须是绝对路径。", "--user-data-dir requires an absolute path and is only for chrome prepare."))
		}
		i++
		dataDir = args[i]
	}
	c, err := parseConfiguration(rest)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, c.node, c.deviceMain(), "--chrome", action, c.deviceDirectory(), dataDir, site)
	cmd.Env = c.serviceEnvironment()
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
