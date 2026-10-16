// Copyright (c) 2026 tyrs-hand contributors. SPDX-License-Identifier: MIT
package sshserver

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var (
	directDesktopProxyCommand = regexp.MustCompile(
		`^(exec[[:space:]]+)?codex[[:space:]]+app-server[[:space:]]+proxy[[:space:]]*$`)
	wrappedDesktopProxyCommand = regexp.MustCompile(
		`^printf[[:space:]]+'%b'[[:space:]]+'((\\[0-7]{3})+)'[[:space:]]*;` +
			`[[:space:]]*PATH="\$\{CODEX_INSTALL_DIR:-\$HOME/\.local/bin\}:\$PATH"[[:space:]]*;` +
			`[[:space:]]*export[[:space:]]+PATH[[:space:]]*;[[:space:]]*` +
			`(exec[[:space:]]+)?codex[[:space:]]+app-server[[:space:]]+proxy[[:space:]]*$`)
	// 远程启动器外层的检查与包装文案随客户端版本变化，只以最终负载是否执行 proxy 为准。
	remoteDesktopLauncher = regexp.MustCompile(
		`(?s)^sh[[:space:]]+-c[[:space:]].*(^|[^[:alnum:]_-])codex[[:space:]]+app-server[[:space:]]+proxy'?[[:space:]]*$`)
	remoteDesktopHandshake = regexp.MustCompile(`((\\[0-7]{3}){8})`)
)

func parseDesktopProxyCommand(command string) ([]byte, bool, error) {
	trimmed := strings.TrimSpace(command)
	if directDesktopProxyCommand.MatchString(trimmed) {
		return nil, true, nil
	}
	matches := wrappedDesktopProxyCommand.FindStringSubmatch(trimmed)
	if len(matches) > 1 {
		return decodeDesktopHandshake(matches[1])
	}
	if remoteDesktopLauncher.MatchString(trimmed) {
		if matches := remoteDesktopHandshake.FindStringSubmatch(trimmed); len(matches) > 1 {
			return decodeDesktopHandshake(matches[1])
		}
		return nil, true, nil
	}
	// 只识别需要接入 SSH Hub 的官方 Desktop proxy 命令；未识别的命令交给登录 shell，
	// 其中的 codex 经 CODEX_INSTALL_DIR 解析为入口包装器，同样接入本入口的 Hub。
	return nil, false, nil
}

func decodeDesktopHandshake(encoded string) ([]byte, bool, error) {
	handshake, err := strconv.Unquote(`"` + encoded + `"`)
	if err != nil {
		return nil, true, errors.New("codex Desktop SSH 握手无效")
	}
	return []byte(handshake), true, nil
}
