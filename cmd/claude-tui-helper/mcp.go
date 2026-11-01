package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

// 每个 CLI 的 MCP stdio 连接只转交该会话的宿主服务器；不执行任何客户端工具。
func mcp(args []string) error {
	args, err := bridgeArguments(args)
	if err != nil {
		return err
	}
	if len(args) != 2 || args[1] == "" {
		return errors.New("MCP 桥缺少地址或令牌")
	}
	endpoint, err := url.Parse(args[0])
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.User != nil {
		return errors.New("MCP 桥只能连接本机回环 HTTP")
	}
	client := &http.Client{Timeout: 10 * time.Minute, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("禁止重定向") }}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		body := scanner.Bytes()
		if !json.Valid(body) {
			return errors.New("MCP 输入不是 JSON")
		}
		req, err := http.NewRequest(http.MethodPost, endpoint.String(), bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+args[1])
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		result, readErr := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode != 200 || len(result) > 16<<20 {
			return errors.New("MCP 桥响应失败")
		}
		if len(result) == 0 {
			continue
		}
		if !json.Valid(result) {
			return errors.New("MCP 桥响应不是 JSON")
		}
		if _, err := os.Stdout.Write(append(result, '\n')); err != nil {
			return err
		}
	}
	return scanner.Err()
}
