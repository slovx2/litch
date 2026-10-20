//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 一个只会 `debug models --bundled` 的假 codex：印一份目录，模型名里带上它看到的 CODEX_HOME，每跑一次记一笔。
func writeCatalogCodex(t *testing.T, cfg configuration) (launcher, runs string) {
	t.Helper()
	node, err := exec.LookPath(cfg.node)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(cfg.home, "catalog-codex")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	runs = filepath.Join(directory, "runs")
	fixture := fmt.Sprintf(`import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ') !== 'debug models --bundled') { console.error('unexpected ' + args.join(' ')); process.exit(2); }
fs.appendFileSync(%q, 'x');
console.log(JSON.stringify({models: [{slug: 'm-' + (process.env.CODEX_HOME ?? 'none'), priority: 1}]}));
`, runs)
	script := filepath.Join(directory, "fixture.mjs")
	if err := os.WriteFile(script, []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher = filepath.Join(directory, "codex")
	if err := os.WriteFile(launcher, []byte(fmt.Sprintf("#!/bin/sh\nexec %q %q \"$@\"\n", node, script)), 0o700); err != nil {
		t.Fatal(err)
	}
	return launcher, runs
}

// codex.models：照设置找到的 codex、带设置里的环境跑 debug models --bundled，输出原样给回；
// 同一个可执行文件只跑一次，文件变了重跑；没有这个命令的 codex 报 failed。
func TestControlCodexModels(t *testing.T) {
	bundledModels = codexModelsCache{}
	cfg, _, control, stop := startManaged(t)
	defer stop()
	launcher, runs := writeCatalogCodex(t, cfg)
	dataHome := filepath.Join(cfg.home, "models-data")
	control.write(0, edit(cliPathKey(nativeCodex), launcher), edit(envKey(nativeCodex), []map[string]any{{"name": "CODEX_HOME", "value": dataHome}}))
	var reply struct {
		Executable string `json:"executable"`
		Catalog    struct {
			Models []struct {
				Slug string `json:"slug"`
			} `json:"models"`
		} `json:"catalog"`
	}
	control.must("codex.models", nil, &reply)
	if reply.Executable != launcher || len(reply.Catalog.Models) != 1 || reply.Catalog.Models[0].Slug != "m-"+dataHome {
		t.Fatalf("应答不对: %+v", reply)
	}
	control.must("codex.models", nil, &reply)
	if count, _ := os.ReadFile(runs); string(count) != "x" {
		t.Fatalf("同一个可执行文件应只跑一次，跑了 %q", count)
	}
	later := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(launcher, later, later); err != nil {
		t.Fatal(err)
	}
	control.must("codex.models", nil, &reply)
	if count, _ := os.ReadFile(runs); string(count) != "xx" {
		t.Fatalf("可执行文件变了应重跑，跑了 %q", count)
	}

	control.write(1, edit(cliPathKey(nativeCodex), writeFakeCodex(t, cfg, "0.160.0")))
	if _, failure := control.call("codex.models", nil); failure == nil || failure.Reason != "failed" || !strings.Contains(failure.Text.ZH, "debug models") {
		t.Fatalf("没有这个命令时应报 failed: %+v", failure)
	}
	control.write(2, edit(cliPathKey(nativeCodex), filepath.Join(cfg.home, "nowhere", "codex")))
	if _, failure := control.call("codex.models", nil); failure == nil || failure.Reason != "failed" {
		t.Fatalf("找不到 codex 时应报 failed: %+v", failure)
	}
}
