package sshtransport

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// 远端的命令固定是 `exec sh`，脚本从标准输入喂进去（和桌面端 apps/desktop/src/ssh/script.mts 同一种送法），
// 远程命令里就没有任何要转义的东西
const remoteCommand = "exec sh"

type runResult struct {
	// 标记那一行之后的标准输出：登录 shell 启动时写的东西都在标记之前
	Output string `json:"output"`
	// 没见到标记时为 false：脚本没跑到那一行就退出了
	Marked bool   `json:"marked"`
	Code   int    `json:"code"`
	Stderr string `json:"stderr"`
}

// RunScript 连上去跑一段脚本，等它结束，返回 JSON（runResult）。探测和启动用
func RunScript(targetJSON, script, marker string) (string, error) {
	target, err := parseTarget(targetJSON)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	client, err := connectSSH(ctx, target)
	if err != nil {
		return "", err
	}
	defer func() { _ = client.Close() }()
	go func() {
		<-ctx.Done()
		_ = client.Close()
	}()
	session, err := newSession(client, target)
	if err != nil {
		return "", err
	}
	defer func() { _ = session.Close() }()
	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	session.Stdin = strings.NewReader(script)
	code := 0
	if err = session.Run(remoteCommand); err != nil {
		var exit *ssh.ExitError
		if !errors.As(err, &exit) {
			return "", err
		}
		code = exit.ExitStatus()
	}
	output, marked := afterMarker(stdout.String(), marker)
	return marshalJSON(runResult{Output: output, Marked: marked, Code: code, Stderr: tail(stderr.String(), 4000)})
}

// afterMarker 丢掉标记那一行及之前的全部输出
func afterMarker(text, marker string) (string, bool) {
	at := strings.Index(text, marker)
	if at < 0 {
		return "", false
	}
	rest := text[at+len(marker):]
	if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
		return rest[newline+1:], true
	}
	return "", true
}

func tail(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[len(text)-limit:]
}
