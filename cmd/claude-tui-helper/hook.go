package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// command 的 exec form 直接运行此二进制，不经过 shell 或 Node。CLI 仍必须设置
// onFailure:block，以覆盖进程根本没启动、被外部杀死以及 CLI 自己的 hook 超时。
func hook(args []string, input io.Reader, output io.Writer) (err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("权限桥异常：%v", value)
		}
	}()
	if len(args) != 2 || args[1] == "" {
		return errors.New("权限桥缺少地址或令牌")
	}
	endpoint, err := url.Parse(args[0])
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.User != nil {
		return errors.New("权限桥只能连接本机回环 HTTP")
	}
	body, err := io.ReadAll(io.LimitReader(input, (4<<20)+1))
	if err != nil || len(body) > 4<<20 || !json.Valid(body) {
		return errors.New("权限桥输入不是有效 JSON")
	}
	request, err := http.NewRequest(http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+args[1])
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Litch-Cli-Pid", strconv.Itoa(os.Getppid()))
	client := &http.Client{
		Timeout:       10 * time.Minute,
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("权限桥禁止重定向") },
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("权限桥不可用，拒绝执行：%w", err)
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(result) > 4<<20 || response.StatusCode != http.StatusOK {
		return errors.New("权限桥响应失败，拒绝执行")
	}
	var envelope map[string]any
	if json.Unmarshal(result, &envelope) != nil || envelope == nil {
		return errors.New("权限桥未返回 JSON 对象，拒绝执行")
	}
	var event struct {
		Name string `json:"hook_event_name"`
	}
	if json.Unmarshal(body, &event) != nil {
		return errors.New("权限桥事件无效")
	}
	if event.Name == "PreToolUse" {
		specific, ok := envelope["hookSpecificOutput"].(map[string]any)
		if !ok || specific["hookEventName"] != "PreToolUse" ||
			(specific["permissionDecision"] != "allow" && specific["permissionDecision"] != "deny") {
			return errors.New("权限桥没有明确允许或拒绝，拒绝执行")
		}
	}
	_, err = output.Write(append(result, '\n'))
	return err
}

// 令牌只在属主可读的文件里，CLI/工具的进程参数只包含路径。
func bridgeArguments(args []string) ([]string, error) {
	if len(args) != 2 {
		return nil, errors.New("桥接凭据参数无效")
	}
	file, err := os.Open(args[1])
	if err != nil {
		return nil, errors.New("桥接凭据不可读")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 129))
	token := strings.TrimSpace(string(data))
	decoded, decodeErr := hex.DecodeString(token)
	if err != nil || decodeErr != nil || len(decoded) != 32 || len(data) > 128 {
		return nil, errors.New("桥接凭据无效")
	}
	return []string{args[0], token}, nil
}

func runHook(args []string) int {
	args, err := bridgeArguments(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err := hook(args, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	return 0
}
