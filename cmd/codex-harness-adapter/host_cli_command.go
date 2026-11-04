package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Windows 的 npm shim 不能由 exec 直接运行。读取同一安装的官方 bin 声明，避免把用户路径拼进 shell。
func hostCLIExecutable(path string) string {
	if runtime.GOOS != "windows" || !strings.EqualFold(filepath.Ext(path), ".cmd") {
		return path
	}
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	packages := []string{}
	if name == "npm" {
		packages = append(packages, "npm")
	}
	for _, spec := range harnessTable {
		if spec.install == nil {
			continue
		}
		for _, command := range spec.install.commands {
			if command == name {
				packages = append(packages, spec.install.npmPackage)
			}
		}
	}
	for _, pkg := range packages {
		root := filepath.Join(filepath.Dir(path), "node_modules", filepath.FromSlash(pkg))
		data, err := os.ReadFile(filepath.Join(root, "package.json"))
		if err != nil {
			continue
		}
		var manifest struct {
			Bin json.RawMessage `json:"bin"`
		}
		if json.Unmarshal(data, &manifest) != nil {
			continue
		}
		var entry string
		if json.Unmarshal(manifest.Bin, &entry) != nil {
			var bins map[string]string
			if json.Unmarshal(manifest.Bin, &bins) != nil {
				continue
			}
			entry = bins[name]
		}
		if entry == "" {
			continue
		}
		target := filepath.Join(root, filepath.FromSlash(entry))
		if file, err := os.Stat(target); err == nil && !file.IsDir() {
			return target
		}
	}
	return path
}

func hostCLICommand(ctx context.Context, path string, env []string, args ...string) *exec.Cmd {
	path = hostCLIExecutable(path)
	extension := strings.ToLower(filepath.Ext(path))
	if extension == ".js" || extension == ".cjs" || extension == ".mjs" {
		node := lookPath(envPath(env), "node")
		return exec.CommandContext(ctx, node, append([]string{path}, args...)...)
	}
	return exec.CommandContext(ctx, path, args...)
}
