package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

func deviceAutostartCommand(ctx context.Context, args []string) error {
	if len(args) == 0 || (args[0] != "get" && args[0] != "enable" && args[0] != "disable") {
		return errors.New(tr("用法：device-autostart get|enable|disable [--home DIR]；变更参数用 JSON 从标准输入传入。", "Usage: device-autostart get|enable|disable [--home DIR]; pass mutation parameters as JSON on stdin."))
	}
	c, err := parseConfiguration(args[1:])
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if args[0] != "get" {
		const limit = 8192
		raw, err = io.ReadAll(io.LimitReader(os.Stdin, limit+1))
		if err != nil {
			return err
		}
		if len(raw) > limit {
			return errors.New(tr("自启参数过长。", "Autostart parameters are too long."))
		}
	}
	return runDeviceAutostart(ctx, c, args[0], raw)
}

// H 线接到独立子命令：先解析 get/enable/disable 和公共适配器配置，
// 写操作再把契约中的参数交给此函数。CLI 与设备 RPC 共用校验和操作日志。
func runDeviceAutostart(ctx context.Context, c configuration, action string, raw json.RawMessage) error {
	h, err := newAutostartHost(c)
	if err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	switch action {
	case "get":
		status, err := h.get(ctx)
		if err != nil {
			return err
		}
		return out.Encode(status)
	case "enable", "disable":
		params, failure := decodeAutostartParams(raw, action == "enable")
		if failure != nil {
			return errors.New(failure.Text.String())
		}
		result, failure := h.queue(ctx, action, params)
		if failure != nil {
			return errors.New(failure.Text.String())
		}
		if err := out.Encode(result); err != nil {
			return err
		}
		if op, ok := result.(autostartMutationResult); ok && op.State == "accepted" {
			return h.release(ctx, op.OperationID)
		}
		return nil
	default:
		return fmt.Errorf(tr("未知自启操作：%s", "unknown autostart action: %s"), action)
	}
}
