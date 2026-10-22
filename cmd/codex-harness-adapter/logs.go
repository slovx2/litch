package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 日志都在 <状态目录>/logs/ 下：service.log、control.jsonl、device.log、device.jsonl 在顶层，
// 每个 harness 一个子目录（runtime.log、diagnostics.log、rpc.jsonl，Claude 还有 debug.jsonl）。
// 上限和 Node 那一层（packages/shared/src/log-file.mts）一样，由三个环境变量调。
//
// 谁来换：
//   - .jsonl 由写它的进程自己换（改名：x → x.1 → x.2……）；
//   - .log 是别的进程拿着句柄一直写的（运行时的标准错误），改名的话它会接着写进改了名的那份，
//     所以由这里“复制再截断”：内容复制到 x.1，原文件截成 0。写的一方都是追加模式，截断后从头接着写；
//     复制和截断之间写进来的几行会丢。打开时看一次，常驻服务每隔一阵把整个目录扫一遍（keepLogs）。

// 交给 Node 进程的日志目录。它们一启动就从自己的环境里拿走，再起的进程看不到。
const logDirEnvironment = "LITCH_LOG_DIR"

func (c configuration) logsDirectory() string { return filepath.Join(c.home, "logs") }

// 这个 harness 的日志目录
func (c configuration) harnessLogDirectory() string {
	return filepath.Join(c.logsDirectory(), c.harness)
}

type logLimits struct {
	maxBytes int64         // 0：不按大小换
	keep     int           // 含正在写的那个，至少 1
	maxAge   time.Duration // 0：不按时长删
}

// 环境变量里的非负数，没设或不对就用默认
func logNumber(name string, fallback float64) float64 {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value < 0 {
		return fallback
	}
	return value
}

func currentLogLimits() logLimits {
	keep := int(logNumber("LITCH_LOG_KEEP", 5))
	if keep < 1 {
		keep = 1
	}
	return logLimits{
		maxBytes: int64(logNumber("LITCH_LOG_MAX_BYTES", 10*1024*1024)),
		keep:     keep,
		maxAge:   time.Duration(logNumber("LITCH_LOG_MAX_AGE_DAYS", 7) * float64(24*time.Hour)),
	}
}

// Claude 的 debug.jsonl 大小和个数沿用它原来的两个变量（单个 50MB，另留 3 份旧的，不含正在写的），
// 按时长删和别的一样。和 packages/claude/src/util.mts 的 debugLogLimits 是同一套。
func limitsFor(path string, limits logLimits) logLimits {
	if filepath.Base(path) != "debug.jsonl" {
		return limits
	}
	keep := int(logNumber("CHA_CLAUDE_DEBUG_LOG_KEEP", 3))
	if keep < 1 {
		keep = 1
	}
	return logLimits{
		maxBytes: int64(logNumber("CHA_CLAUDE_DEBUG_LOG_MAX_BYTES", 50*1024*1024)),
		keep:     keep + 1,
		maxAge:   limits.maxAge,
	}
}

var logLimitVariables = []string{
	"LITCH_LOG_MAX_BYTES", "LITCH_LOG_KEEP", "LITCH_LOG_MAX_AGE_DAYS",
	"CHA_CLAUDE_DEBUG_LOG_MAX_BYTES", "CHA_CLAUDE_DEBUG_LOG_KEEP",
}

// 后台服务拿不到终端里的环境变量，所以环境文件里的日志上限也算数：放进这个进程自己的环境，
// 这一层（currentLogLimits）和它起的 Node 进程（经 os.Environ 继承）就按同一套上限。进程环境里设了的以进程环境为准。
func applyUserLogLimits(userEnv map[string]string) {
	for _, name := range logLimitVariables {
		if value, ok := userEnv[name]; ok && os.Getenv(name) == "" {
			_ = os.Setenv(name, value)
		}
	}
}

func rotatedLogName(path string, n int) string { return path + "." + strconv.Itoa(n) }

// 把旧文件往后挪一位（x.1 → x.2……），超出个数的删掉，空出 x.1。返回 false 表示只留一个文件、没有 x.1 可用。
func shiftRotated(path string, limits logLimits) bool {
	oldest := limits.keep - 1
	if oldest < 1 {
		return false
	}
	_ = os.Remove(rotatedLogName(path, oldest))
	for n := oldest - 1; n >= 1; n-- {
		_ = os.Rename(rotatedLogName(path, n), rotatedLogName(path, n+1))
	}
	return true
}

// 复制再截断（给别的进程拿着句柄写的 .log）。复制出来的那份保留原来的修改时间：过期的照样按时长删。
func rotateHeldLog(path string, limits logLimits) error {
	source, err := os.Open(path)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if shiftRotated(path, limits) {
		target, err := os.OpenFile(rotatedLogName(path, 1), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(target, source)
		closeErr := target.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		_ = os.Chtimes(rotatedLogName(path, 1), info.ModTime(), info.ModTime())
	}
	return os.Truncate(path, 0)
}

// 改名换下（给自己写的 .jsonl）。之后写的人会建一个新的。
func rotateOwnLog(path string, limits logLimits) {
	if shiftRotated(path, limits) {
		_ = os.Rename(path, rotatedLogName(path, 1))
		return
	}
	_ = os.Truncate(path, 0)
}

var rotatedPattern = regexp.MustCompile(`^(.+\.(?:log|jsonl))\.([0-9]+)$`)

// 按个数和时长清理一个来源的旧文件；正在写的太久没动过也删（.log 截成 0，拿着它的进程照样能接着写）。
func pruneLog(path string, limits logLimits, now time.Time) {
	expired := func(info fs.FileInfo) bool {
		return limits.maxAge > 0 && now.Sub(info.ModTime()) > limits.maxAge
	}
	if info, err := os.Stat(path); err == nil && info.Size() > 0 && expired(info) {
		if strings.HasSuffix(path, ".log") {
			_ = os.Truncate(path, 0)
		} else {
			_ = os.Remove(path)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return
	}
	name := filepath.Base(path)
	for _, entry := range entries {
		match := rotatedPattern.FindStringSubmatch(entry.Name())
		if match == nil || match[1] != name {
			continue
		}
		n, _ := strconv.Atoi(match[2])
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if n < 1 || n > limits.keep-1 || expired(info) {
			_ = os.Remove(filepath.Join(filepath.Dir(path), entry.Name()))
		}
	}
}

// 打开一份 .log 之前：到了上限先换下来，再清理旧的。
func prepareHeldLog(path string, limits logLimits, now time.Time) {
	if info, err := os.Stat(path); err == nil && limits.maxBytes > 0 && info.Size() >= limits.maxBytes {
		_ = rotateHeldLog(path, limits)
	}
	pruneLog(path, limits, now)
}

// 把整个日志目录扫一遍：到了上限的 .log 换下来，所有来源按个数和时长清理。.jsonl 的大小归写它的进程管。
// 正在写的那份没了、只剩旧的（比如过期删掉了），也照它的名字清理。
func tidyLogs(root string, limits logLimits, now time.Time) {
	sources := map[string]bool{}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if match := rotatedPattern.FindStringSubmatch(entry.Name()); match != nil {
			path = filepath.Join(filepath.Dir(path), match[1])
		}
		if strings.HasSuffix(path, ".log") || strings.HasSuffix(path, ".jsonl") {
			sources[path] = true
		}
		return nil
	})
	for path := range sources {
		if strings.HasSuffix(path, ".log") {
			prepareHeldLog(path, limits, now)
		} else {
			pruneLog(path, limitsFor(path, limits), now)
		}
	}
}

// 常驻服务里一直跑着：每隔 logTidyInterval 扫一遍日志目录。起来时先扫一遍。
var logTidyInterval = 10 * time.Minute

func keepLogs(ctx context.Context, c configuration) {
	root := c.logsDirectory()
	tidyLogs(root, currentLogLimits(), time.Now())
	ticker := time.NewTicker(logTidyInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tidyLogs(root, currentLogLimits(), time.Now())
		}
	}
}

// 一行一条 JSON 的摘要日志，这一层自己写（control.jsonl）。每条现开现关；到了上限改名换下。
type jsonLog struct {
	mu     sync.Mutex
	path   string
	source string
	now    func() time.Time
}

func newJSONLog(path, source string) *jsonLog {
	return &jsonLog{path: path, source: source, now: time.Now}
}

// 记一条。fields 里只放方法、标识、成败、耗时、错误原文，不放参数和内容。写不成就算了。
func (l *jsonLog) write(level, event string, fields map[string]any) {
	if l == nil {
		return
	}
	entry := map[string]any{}
	for key, value := range fields {
		entry[key] = value
	}
	entry["ts"] = l.now().UTC().Format("2006-01-02T15:04:05.000Z")
	entry["level"] = level
	entry["src"] = l.source
	entry["pid"] = os.Getpid()
	entry["event"] = event
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	limits := currentLogLimits()
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return
	}
	if info, err := os.Stat(l.path); err == nil && limits.maxBytes > 0 && info.Size() >= limits.maxBytes {
		rotateOwnLog(l.path, limits)
		pruneLog(l.path, limits, l.now())
	} else if errors.Is(err, os.ErrNotExist) {
		pruneLog(l.path, limits, l.now())
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = file.Write(append(line, '\n'))
	_ = file.Close()
}

// 错误原文截到 500 字（和 Node 那一层一样）
func logErrorText(text string) string {
	runes := []rune(text)
	if len(runes) > 500 {
		return string(runes[:500]) + "…"
	}
	return text
}
