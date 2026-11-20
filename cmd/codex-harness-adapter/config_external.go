package main

// 令牌走本机私有设备套接字，不经过 litch_config、桌面确认卡或模型输入。
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

func externalStdinArgs(rest []string) ([]string, bool) {
	var args []string
	switch {
	case len(rest) >= 2 && rest[0] == "device-identity" && (rest[1] == "paste" || rest[1] == "rotate"):
		args = rest[1:]
	case len(rest) >= 3 && rest[0] == "device-source" && rest[1] == "credential":
		args = append([]string(nil), rest[2:]...)
		if args[0] == "configure" {
			args[0] = "paste"
		}
	default:
		return nil, false
	}
	for _, arg := range args[1:] {
		if arg == "--" || arg == "--help" || arg == "-h" {
			return nil, false
		}
	}
	for _, arg := range args[1:] {
		if arg == "--stdin" {
			return args, true
		}
	}
	return nil, false
}

func configExternalStdin(ctx context.Context, args []string, asJSON bool, streams machineIO) int {
	action := args[0]
	var positionals []string
	seen := map[string]bool{}
	usage := func() int {
		fmt.Fprintln(streams.stderr, tr(
			"用法：litch config device-identity paste --stdin，或 device-identity rotate <身份 ID> <凭据引用> --stdin。只支持目标设备本机。",
			"Usage: litch config device-identity paste --stdin, or device-identity rotate <identity-id> <credential-ref> --stdin. Run on the target device.",
		))
		return machineExitUsage
	}
	for j := 1; j < len(args); j++ {
		word := args[j]
		switch word {
		case "--stdin", "--device":
			if seen[word] {
				return usage()
			}
			seen[word] = true
			if word == "--device" {
				j++
				if j == len(args) || args[j] != "local" {
					return usage()
				}
			}
		default:
			if len(word) == 0 || len(word) > 256 || strings.HasPrefix(word, "-") {
				return usage()
			}
			positionals = append(positionals, word)
		}
	}
	if (action != "paste" || len(positionals) != 0) && (action != "rotate" || len(positionals) != 2) {
		return usage()
	}
	if file, ok := streams.stdin.(*os.File); ok {
		if info, err := file.Stat(); err != nil || info.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprintln(streams.stderr, tr("请从管道读入令牌；在桌面输入请去掉 --stdin。", "Pipe the token to stdin, or omit --stdin to enter it on the desktop."))
			return machineExitUsage
		}
	}
	const maxToken = 4096
	buffer, err := io.ReadAll(io.LimitReader(streams.stdin, maxToken+3))
	defer clear(buffer)
	token := strings.TrimSuffix(strings.TrimSuffix(string(buffer), "\n"), "\r")
	if err != nil || len(token) == 0 || len(token) > maxToken || strings.ContainsAny(token, "\x00\r\n\t ") {
		fmt.Fprintln(streams.stderr, tr("标准输入需要一行有效令牌。", "Provide one valid token on stdin."))
		return machineExitUsage
	}

	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	rpc, err := dialDevice(ctx, machineSocket("", streams.env))
	if err != nil {
		fmt.Fprintln(streams.stderr, tr("连不上本机设备服务。", "Could not connect to the local device service."))
		return machineExitUnreachable
	}
	defer rpc.Close()
	return configExternalCredential(ctx, rpc, action, positionals, token, asJSON, streams)
}

type configIdentity struct {
	ID          string                     `json:"identityId"`
	BotUserID   string                     `json:"botUserId"`
	Login       string                     `json:"login"`
	Revision    int64                      `json:"revision"`
	Credentials []configCredentialMetadata `json:"credentials"`
}

type configCredentialMetadata struct {
	Ref           string   `json:"credentialRef"`
	ResourceOwner string   `json:"resourceOwnerId"`
	Generation    int64    `json:"generation"`
	State         string   `json:"state"`
	Kind          string   `json:"credentialKind,omitempty"`
	Scopes        []string `json:"scopes,omitempty"`
}

func configExternalCredential(ctx context.Context, rpc *deviceRPC, action string, args []string, token string, asJSON bool, streams machineIO) int {
	failed := func() int {
		fmt.Fprintln(streams.stderr, tr("设备未完成凭据操作，请检查身份、权限或设备版本后重试。", "The device did not complete the credential operation. Check the identity, permissions or device version, then retry."))
		return machineExitFailed
	}
	if _, err := rpc.call(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "litch-config", "title": "Litch config", "version": selfVersion()},
		"capabilities": map[string]any{"litchExtensions": []string{"harness", "litchExternalSources"}},
	}); err != nil {
		return failed()
	}
	if err := rpc.conn.WriteJSON(map[string]string{"method": "initialized"}); err != nil {
		return failed()
	}
	const prefix = "litch/external/identities/"
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return failed()
	}
	params := map[string]any{"operationId": "cli-" + hex.EncodeToString(nonce[:]), "token": token}
	if action == "rotate" {
		raw, err := rpc.call(ctx, prefix+"list", map[string]any{})
		var list struct {
			Identities []configIdentity `json:"identities"`
		}
		if err != nil || json.Unmarshal(raw, &list) != nil {
			return failed()
		}
		var generation int64
		for _, identity := range list.Identities {
			if identity.ID != args[0] {
				continue
			}
			for _, credential := range identity.Credentials {
				if credential.Ref == args[1] {
					generation = credential.Generation
				}
			}
		}
		if generation < 1 {
			return failed()
		}
		params["identityId"] = args[0]
		params["credentialRef"] = args[1]
		params["expectedGeneration"] = generation
	}
	raw, err := rpc.call(ctx, prefix+action, params)
	if action == "paste" {
		var state configLoginStatus
		if err != nil || json.Unmarshal(raw, &state) != nil || state.State != "succeeded" || state.Result == nil {
			return failed()
		}
		safe, err := json.Marshal(state)
		if err != nil || strings.Contains(string(safe), token) {
			return failed()
		}
		text := fmt.Sprintf("@%s · %s", state.Result.Account.Login, state.Result.Account.UserID)
		if state.NeedsConfirmation {
			text += fmt.Sprintf(tr("\n这是你的 GitHub 账号，尚未保存。请运行 litch config device-identity login confirm %s。", "\nThis is your GitHub account. It has not been saved. Run litch config device-identity login confirm %s."), state.LoginID)
		}
		if asJSON {
			_ = json.NewEncoder(streams.stdout).Encode(map[string]any{"ok": true, "op": "device-identity paste", "data": state, "text": text})
		} else {
			fmt.Fprintln(streams.stdout, text)
		}
		return 0
	}

	var result struct {
		Identity configIdentity `json:"identity"`
	}
	if err != nil || json.Unmarshal(raw, &result) != nil || result.Identity.ID == "" || result.Identity.Login == "" {
		return failed()
	}
	// 即使设备错误地在公开字段里回显令牌，也不向命令行输出。
	public, err := json.Marshal(result)
	if err != nil || strings.Contains(string(public), token) {
		return failed()
	}
	op := "device-identity " + action
	text := fmt.Sprintf("@%s · %s · %s", result.Identity.Login, result.Identity.ID, result.Identity.BotUserID)
	if asJSON {
		_ = json.NewEncoder(streams.stdout).Encode(map[string]any{"ok": true, "op": op, "data": result, "text": text})
	} else {
		fmt.Fprintln(streams.stdout, text)
	}
	return 0
}
