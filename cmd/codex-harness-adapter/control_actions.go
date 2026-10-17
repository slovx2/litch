package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 经控制通道做的几个动作：诊断、读日志末尾、取 ssh 配置片段。

// 诊断和命令行的 doctor 是同一套检查（harnessChecks），另外带上每个 SSH 入口现在的状况。
func (s *controlServer) diagnostics(harness string) (any, *controlError) {
	ids := knownHarnesses
	if harness != "" {
		if !isKnownHarness(harness) {
			return nil, unknownHarness(harness)
		}
		ids = []string{harness}
	}
	results := make([][]diagnosticCheck, len(ids))
	var group sync.WaitGroup
	for index, id := range ids {
		group.Add(1)
		go func() {
			defer group.Done()
			results[index] = s.manager.harnessDiagnostics(s, id)
			if hasSSHEntry(id) {
				results[index] = append(results[index], s.manager.sshEntryCheck(id))
			}
		}()
	}
	group.Wait()
	checks := []diagnosticCheck{}
	for _, result := range results {
		checks = append(checks, result...)
	}
	return map[string]any{"ranAt": time.Now().UTC().Format(time.RFC3339), "checks": checks}, nil
}

func (m *harnessManager) harnessDiagnostics(s *controlServer, id string) []diagnosticCheck {
	// 装了才启用的（dsh、OpenCode）没装时不算毛病，和启动时不告警是一个道理；默认不启用的（ACP 那几个）
	// 没打开（或者关掉了）时也一样，用户没要它：都记成跳过，说明原因。
	enabled, state, text := m.wanted(id)
	if !enabled && (state == stateNotInstalled || specOf(id).enable == enableOptIn) {
		return []diagnosticCheck{{ID: "runtime", Scope: harnessScope(id), Status: "skipped", Detail: &text,
			Title: both("引擎的命令行和运行环境", "Engine CLI and runtime environment")}}
	}
	// 原生 codex 没启用时也一样：用户没要它，装没装、版本够不够都不算毛病。
	if !enabled && id == nativeCodex {
		return []diagnosticCheck{{ID: "runtime", Scope: harnessScope(id), Status: "skipped", Detail: &text, Title: codexCheckTitle}}
	}
	return harnessChecks(s.ctx, m.base.forHarness(id))
}

func (m *harnessManager) sshEntryCheck(id string) diagnosticCheck {
	view := m.sshEntry(id)
	check := diagnosticCheck{ID: "sshEntry", Scope: harnessScope(id), Status: "skipped",
		Title: both("给 Codex 桌面端的 SSH 入口", "SSH entry for the Codex desktop app")}
	var detail bilingual
	switch view.State {
	case "listening":
		check.Status = "ok"
		detail = both("在 127.0.0.1:%d 上监听", "Listening on 127.0.0.1:%d").with(view.Port)
	case "failed":
		check.Status = "failed"
		detail = view.Reason.Text
		logPath := filepath.Join(m.base.home, id, "runtime.log")
		check.LogPath = &logPath
	case "off":
		detail = both("入口在设置里关着", "The entry is turned off in settings")
	default:
		detail = both("运行时没在跑，入口没有起", "The runtime is not running, so the entry is not up")
	}
	check.Detail = &detail
	return check
}

const (
	logTailDefault = 64 * 1024
	logTailLimit   = 1024 * 1024
)

type logRequest struct {
	Source   string `json:"source"` // device、service、runtime、diagnostics
	Harness  string `json:"harness"`
	MaxBytes int64  `json:"maxBytes"`
}

func (s *controlServer) logTail(request logRequest) (any, *controlError) {
	var path string
	switch request.Source {
	case "device":
		path = s.c.deviceLog()
	case "service":
		path = filepath.Join(s.c.deviceDirectory(), "service.log")
	case "runtime", "diagnostics":
		if !isKnownHarness(request.Harness) {
			return nil, unknownHarness(request.Harness)
		}
		path = filepath.Join(s.c.home, request.Harness, request.Source+".log")
	default:
		return nil, &controlError{Reason: "invalid", Text: both("没有 %q 这种日志", "There is no log called %q").with(request.Source)}
	}
	limit := request.MaxBytes
	if limit <= 0 {
		limit = logTailDefault
	}
	limit = min(limit, logTailLimit)
	text, truncated, size, err := tailFile(path, limit)
	if err != nil {
		return nil, controlFailure(err)
	}
	return map[string]any{"path": path, "text": text, "truncated": truncated, "size": size}, nil
}

// 取文件末尾至多 limit 个字节，从整行开始。文件不存在不算错，就是还没有日志。
func tailFile(path string, limit int64) (text string, truncated bool, size int64, err error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, 0, nil
	}
	if err != nil {
		return "", false, 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", false, 0, err
	}
	size = info.Size()
	start := max(0, size-limit)
	data := make([]byte, size-start)
	if _, err := io.ReadFull(io.NewSectionReader(file, start, size-start), data); err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", false, size, err
	}
	if start > 0 {
		if cut := bytes.IndexByte(data, '\n'); cut >= 0 {
			data = data[cut+1:]
		}
	}
	return strings.ToValidUTF8(string(data), "�"), start > 0, size, nil
}

type sshConfigEntry struct {
	Harness string `json:"harness"`
	Alias   string `json:"alias"`
	Port    int    `json:"port"`
	// 可以直接贴进 ~/.ssh/config 的一段；给不出来时为空，原因在 Unavailable 里。
	Config      *string    `json:"config"`
	Unavailable *bilingual `json:"unavailable"`
}

func (s *controlServer) sshConfig() any {
	entries := []sshConfigEntry{}
	blocks := []string{}
	for _, id := range adapterHarnesses {
		entry := s.manager.base.forHarness(id)
		item := sshConfigEntry{Harness: id, Alias: sshAlias(id), Port: entry.port}
		if entry.sshDisabled {
			reason := both("这个入口在设置里关着", "This entry is turned off in settings")
			item.Unavailable = &reason
		} else if block, err := sshConfigBlock(entry); err != nil {
			reason := both(
				"这个入口还没有初始化过：它的 harness 起来一次之后才有身份和主机密钥",
				"This entry has not been initialised yet: its identity and host key are created the first time its harness starts",
			)
			item.Unavailable = &reason
		} else {
			item.Config = &block
			blocks = append(blocks, block)
		}
		entries = append(entries, item)
	}
	return map[string]any{"entries": entries, "text": strings.Join(blocks, "\n")}
}
