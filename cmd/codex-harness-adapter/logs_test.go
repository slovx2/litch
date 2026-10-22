package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, text string, modified time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// 别的进程拿着句柄追加写的 .log：复制再截断之后，那个句柄接着写进的是原来的文件，不是换下来的那份
func TestHeldLogRotatesByCopyAndTruncate(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "runtime.log")
	limits := logLimits{maxBytes: 16, keep: 3, maxAge: 0}
	holder, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	for round, text := range []string{"first-0123456789\n", "second-012345678\n", "third-0123456789\n"} {
		if _, err := holder.WriteString(text); err != nil {
			t.Fatal(err)
		}
		prepareHeldLog(path, limits, time.Now())
		if info, _ := os.Stat(path); info.Size() != 0 {
			t.Fatalf("第 %d 次到了上限应截成 0，现在 %d 字节", round+1, info.Size())
		}
	}
	if _, err := holder.WriteString("after\n"); err != nil {
		t.Fatal(err)
	}
	current, _ := os.ReadFile(path)
	newest, _ := os.ReadFile(rotatedLogName(path, 1))
	older, _ := os.ReadFile(rotatedLogName(path, 2))
	if string(current) != "after\n" || string(newest) != "third-0123456789\n" || string(older) != "second-012345678\n" {
		t.Fatalf("换下来的内容不对: %q %q %q", current, newest, older)
	}
	if exists(rotatedLogName(path, 3)) {
		t.Fatal("每个来源最多 3 个文件（含正在写的），不该有 .3")
	}
}

// 按时长：旧文件最后一次写入超过期限就删；正在写的 .log 太久没动截成 0，.jsonl 删掉；编号超出的删
func TestTidyLogsPrunesByAgeAndCount(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	limits := logLimits{maxBytes: 1 << 20, keep: 3, maxAge: 7 * 24 * time.Hour}
	fresh, stale := now.Add(-time.Hour), now.Add(-8*24*time.Hour)
	writeFile(t, filepath.Join(root, "device.log"), "live\n", fresh)
	writeFile(t, filepath.Join(root, "device.log.1"), "old\n", stale)
	writeFile(t, filepath.Join(root, "device.log.2"), "recent\n", fresh)
	writeFile(t, filepath.Join(root, "device.log.7"), "beyond\n", fresh)
	writeFile(t, filepath.Join(root, "pi", "runtime.log"), "idle\n", stale)
	writeFile(t, filepath.Join(root, "pi", "rpc.jsonl"), "{}\n", stale)
	writeFile(t, filepath.Join(root, "pi", "rpc.jsonl.1"), "{}\n", fresh)
	writeFile(t, filepath.Join(root, "claude-code", "debug.jsonl"), "{}\n", fresh)
	writeFile(t, filepath.Join(root, "notes.txt"), "not a log\n", stale)
	tidyLogs(root, limits, now)
	keep := []string{"device.log", "device.log.2", "pi/runtime.log", "pi/rpc.jsonl.1", "claude-code/debug.jsonl", "notes.txt"}
	gone := []string{"device.log.1", "device.log.7", "pi/rpc.jsonl"}
	for _, name := range keep {
		if !exists(filepath.Join(root, name)) {
			t.Errorf("不该删 %s", name)
		}
	}
	for _, name := range gone {
		if exists(filepath.Join(root, name)) {
			t.Errorf("该删 %s", name)
		}
	}
	if info, _ := os.Stat(filepath.Join(root, "pi", "runtime.log")); info.Size() != 0 {
		t.Errorf("太久没写的 .log 应截成 0（拿着它的进程还能接着写）")
	}
}

// 这一层自己写的摘要：一行一条 JSON，到了上限改名换下
func TestJSONLogWritesAndRotates(t *testing.T) {
	t.Setenv("LITCH_LOG_MAX_BYTES", "200")
	t.Setenv("LITCH_LOG_KEEP", "2")
	path := filepath.Join(t.TempDir(), "logs", "control.jsonl")
	journal := newJSONLog(path, "control")
	for i := 0; i < 6; i++ {
		journal.write("info", "control", map[string]any{"method": "settings.read", "ok": true, "ms": i})
	}
	if exists(rotatedLogName(path, 2)) || !exists(rotatedLogName(path, 1)) {
		t.Fatal("留 2 个文件：正在写的和 .1")
	}
	data, _ := os.ReadFile(path)
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("不是 JSON: %q", line)
		}
		if entry["src"] != "control" || entry["event"] != "control" || entry["method"] != "settings.read" || entry["ts"] == nil {
			t.Fatalf("字段不对: %q", line)
		}
	}
	if info, _ := os.Stat(path); info.Size() > 400 {
		t.Fatalf("超出上限太多: %d", info.Size())
	}
}

// 环境文件里的上限也算数，进程环境里设了的为准
func TestLogLimitsFromEnvironmentFile(t *testing.T) {
	t.Setenv("LITCH_LOG_MAX_BYTES", "")
	t.Setenv("LITCH_LOG_KEEP", "7")
	t.Setenv("LITCH_LOG_MAX_AGE_DAYS", "")
	applyUserLogLimits(map[string]string{"LITCH_LOG_MAX_BYTES": "2048", "LITCH_LOG_KEEP": "2", "LITCH_LOG_MAX_AGE_DAYS": "1"})
	limits := currentLogLimits()
	if limits.maxBytes != 2048 || limits.keep != 7 || limits.maxAge != 24*time.Hour {
		t.Fatalf("上限不对: %+v", limits)
	}
}

// 日志目录经环境变量交给子进程：入口拿到自己的子目录，设备进程拿到顶层；外面带进来的同名变量不算数
func TestLogDirectoryIsHandedToChildren(t *testing.T) {
	t.Setenv(logDirEnvironment, "/elsewhere")
	home := t.TempDir()
	c := configuration{home: home, harness: "pi"}
	value := func(env []string) []string {
		var found []string
		for _, entry := range env {
			if name, rest, _ := strings.Cut(entry, "="); name == logDirEnvironment {
				found = append(found, rest)
			}
		}
		return found
	}
	if got := value(c.environment()); len(got) != 1 || got[0] != filepath.Join(home, "logs", "pi") {
		t.Fatalf("入口的日志目录不对: %v", got)
	}
	if got := value(c.serviceEnvironment()); len(got) != 1 || got[0] != filepath.Join(home, "logs") {
		t.Fatalf("设备进程的日志目录不对: %v", got)
	}
}
