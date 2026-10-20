package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 原生 codex 自带的模型目录（控制命令 codex.models）。
// 设备进程替原生 codex 做“模型清单”（litch/harness/models/*）时，要拿 codex 自带目录里每个模型的完整描述当底稿；
// app-server 的 model/list 只给挑选用的摘要，配了自定义清单之后给的还是清单里的。完整的只有命令行
// `codex debug models --bundled`（上游 rust-v0.162.0-alpha.20 的 cli/src/main.rs，0.160.0 实测也有）：
// 不联网，把这个可执行文件里自带的目录（ModelsResponse 的 JSON）印到标准输出。
// 设备进程不知道起 app-server 的是哪个 codex、带的什么环境，所以由这里跑：找法和起 app-server 时一样（locateCodex），
// 环境也一样（configuration.environment）。同一个可执行文件（路径、大小、修改时间都没变）只跑一次。

// 跑一次最多等这么久（实测 0.3 秒上下）。
var codexModelsTimeout = 20 * time.Second

// 输出最多收这么多（实测 0.160.0 是 0.66 MB）；控制通道一行的上限是 16 MB。
const codexModelsLimit = 8 * 1024 * 1024

type codexModelsCache struct {
	mu     sync.Mutex
	key    string
	result map[string]any
}

var bundledModels codexModelsCache

// 限量收输出：超过上限就算失败，不往内存里一直堆。
type limitedBuffer struct {
	bytes.Buffer
	over bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > codexModelsLimit {
		b.over = true
		return 0, fmt.Errorf("output exceeds %d bytes", codexModelsLimit)
	}
	return b.Buffer.Write(p)
}

func (s *controlServer) codexModels() (any, *controlError) {
	c := s.manager.base.forHarness(nativeCodex)
	path, err := locateCodex(c)
	if err != nil {
		return nil, &controlError{Reason: "failed", Harness: nativeCodex, Text: both(
			"找不到 codex 命令行，读不了它自带的模型目录",
			"The codex CLI was not found, so its bundled model catalog cannot be read",
		)}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, &controlError{Reason: "failed", Harness: nativeCodex, Text: both("读不了 %s", "Cannot stat %s").with(path)}
	}
	key := path + "\x00" + strconv.FormatInt(info.Size(), 10) + "\x00" + info.ModTime().UTC().Format(time.RFC3339Nano)
	bundledModels.mu.Lock()
	defer bundledModels.mu.Unlock()
	if bundledModels.key == key {
		return bundledModels.result, nil
	}
	ctx, cancel := context.WithTimeout(s.ctx, codexModelsTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, path, "debug", "models", "--bundled")
	hostplatform.Quiet(command)
	command.Env = c.environment()
	if home, err := os.UserHomeDir(); err == nil {
		command.Dir = home
	}
	var output limitedBuffer
	var problems bytes.Buffer
	command.Stdout, command.Stderr = &output, &problems
	runErr := command.Run()
	var catalog struct {
		Models []json.RawMessage `json:"models"`
	}
	if runErr != nil || output.over || json.Unmarshal(output.Bytes(), &catalog) != nil || len(catalog.Models) == 0 {
		detail := problems.String()
		if len(detail) > 400 {
			detail = detail[:400]
		}
		if runErr != nil && detail == "" {
			detail = runErr.Error()
		}
		return nil, &controlError{Reason: "failed", Harness: nativeCodex, Text: both(
			"codex debug models --bundled 没有给出模型目录（这一版的 codex 可能没有这个命令）：%s",
			"codex debug models --bundled did not print a model catalog (this codex may not have the command): %s",
		).with(detail)}
	}
	result := map[string]any{"executable": path, "catalog": json.RawMessage(output.Bytes())}
	bundledModels.key, bundledModels.result = key, result
	return result, nil
}
