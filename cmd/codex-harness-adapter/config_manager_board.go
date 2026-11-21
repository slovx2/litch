package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const managerBoardLimit = 24 << 20

func configManagerBoard(ctx context.Context, action string, args []string, asJSON bool, streams machineIO) int {
	usage := func(out io.Writer) {
		fmt.Fprintln(out, "litch config managers board-export <manager-id> --file <path> [--from-state <dir>]")
		fmt.Fprintln(out, "litch config managers board-import <manager-id> --file <path> [--dry-run] [--renumber-unreferenced <id>]...")
	}
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		usage(streams.stdout)
		return 0
	}
	var id, path, stateDir string
	var preview bool
	var renumber []string
	for i := 0; i < len(args); i++ {
		value := args[i]
		switch value {
		case "--dry-run":
			if preview || action != "board-import" {
				usage(streams.stderr)
				return machineExitUsage
			}
			preview = true
		case "--file", "--from-state", "--renumber-unreferenced":
			i++
			if i >= len(args) || args[i] == "" || strings.HasPrefix(args[i], "--") {
				usage(streams.stderr)
				return machineExitUsage
			}
			switch {
			case value == "--file" && path == "":
				path = args[i]
			case value == "--from-state" && stateDir == "" && action == "board-export":
				stateDir = args[i]
			case value == "--renumber-unreferenced" && action == "board-import":
				renumber = append(renumber, args[i])
			default:
				usage(streams.stderr)
				return machineExitUsage
			}
		default:
			if id != "" || value == "" || strings.HasPrefix(value, "-") {
				usage(streams.stderr)
				return machineExitUsage
			}
			id = value
		}
	}
	if id == "" || path == "" {
		usage(streams.stderr)
		return machineExitUsage
	}

	failed := func(zh, en string) int {
		fmt.Fprintln(streams.stderr, tr(zh, en))
		return machineExitFailed
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var result json.RawMessage
	var err error
	if stateDir != "" {
		root, rootErr := executableRoot()
		if rootErr != nil {
			return failed("找不到本机适配器。", "Could not locate the local adapter.")
		}
		entry := filepath.Join(filepath.Dir(configuration{root: root}.deviceMain()), "manager-board-export.mjs")
		result, err = exec.CommandContext(ctx, defaultNode(root), entry, stateDir, id).Output()
		if err != nil {
			return failed("只读导出失败。请检查设备状态目录、经理 ID 和源版本。", "Read-only export failed. Check the device state directory, manager ID and source version.")
		}
	} else {
		params := map[string]any{"managerId": id}
		if action == "board-import" {
			f, openErr := os.Open(path)
			if openErr != nil {
				return failed("打不开看板档案。", "Could not open the board archive.")
			}
			data, readErr := io.ReadAll(io.LimitReader(f, managerBoardLimit+1))
			_ = f.Close()
			if readErr != nil || len(data) > managerBoardLimit || !json.Valid(data) {
				return failed("档案必须是 24 MiB 以内的有效 JSON。", "The archive must be valid JSON within 24 MiB.")
			}
			params["archive"] = json.RawMessage(data)
			params["preview"] = preview
			if len(renumber) != 0 {
				params["verifiedUnreferenced"] = renumber
			}
		}
		rpc, dialErr := dialDevice(ctx, machineSocket("", streams.env))
		if dialErr != nil {
			fmt.Fprintln(streams.stderr, tr("连不上本机设备服务。", "Could not connect to the local device service."))
			return machineExitUnreachable
		}
		defer rpc.Close()
		if _, err := rpc.call(ctx, "initialize", map[string]any{
			"clientInfo":   map[string]string{"name": "litch-config", "title": "Litch config", "version": selfVersion()},
			"capabilities": map[string]any{"litchExtensions": []string{"harness", "litchManagerBoardTransfer"}},
		}); err != nil || rpc.conn.WriteJSON(map[string]string{"method": "initialized"}) != nil {
			return failed("本机设备握手失败。", "The local device handshake failed.")
		}
		result, err = rpc.call(ctx, "litch/manager/board/"+strings.TrimPrefix(action, "board-"), params)
		if err != nil {
			// RPC 和数据库错误可能带看板正文，只显示固定提示和已知错误类别。
			if e, ok := err.(*deviceRPCError); ok {
				var data struct {
					Litch string `json:"litch"`
				}
				_ = json.Unmarshal(e.Data, &data)
				switch data.Litch {
				case "managerBoardBusy":
					return failed("经理或输入队列尚未空闲。", "The manager or its input queue is not idle.")
				case "unknownManager":
					return failed("本机没有这个经理。", "This manager does not exist on the local device.")
				case "invalidManagerBoard":
					return failed("设备拒绝了档案或编号计划。请重新导出并预演。", "The device rejected the archive or number plan. Export again and preview the import.")
				}
			}
			return failed("设备未确认操作完成。请核对权限、版本和导入记录，再用同一档案重试。", "The device did not confirm completion. Check permissions, version and the import receipt before retrying with the same archive.")
		}
	}
	if action == "board-export" {
		if !json.Valid(result) || len(result) > managerBoardLimit || writeManagerArchive(path, result) != nil {
			return failed("未写出看板档案。请检查路径权限、大小和是否已存在。", "Could not write the board archive. Check permissions, size and whether the path already exists.")
		}
		result, _ = json.Marshal(map[string]string{"file": path})
	}
	// 回执只含数量、编号和备份路径，不打印看板正文。
	if asJSON {
		_ = json.NewEncoder(streams.stdout).Encode(map[string]any{"ok": true, "op": "managers " + action, "data": result})
	} else {
		_, _ = fmt.Fprintln(streams.stdout, string(result))
	}
	return 0
}

func writeManagerArchive(path string, archive []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(archive); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}
