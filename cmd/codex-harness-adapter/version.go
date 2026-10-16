package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 构建时可以用 -ldflags "-X main.buildVersion=…" 写入版本号。没写时读安装根目录下的 package.json：
// 从源码运行、Homebrew 安装都带着这个文件，版本号只维护那一处。
var buildVersion string

// 两处都拿不到时的占位值。写成合法的预发布号，调用方按版本号解析不会出错。
const unknownVersion = "0.0.0-unknown"

// 可执行文件位于 <根目录>/bin/ 下。Homebrew 等通过符号链接暴露命令，要按真实安装位置推导。
func executableRoot() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	if executable, err = filepath.EvalSymlinks(executable); err != nil {
		return "", err
	}
	return filepath.Dir(filepath.Dir(executable)), nil
}

func adapterVersion(root string) string {
	if value := strings.TrimSpace(buildVersion); value != "" {
		return value
	}
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return unknownVersion
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &manifest) != nil || strings.TrimSpace(manifest.Version) == "" {
		return unknownVersion
	}
	return strings.TrimSpace(manifest.Version)
}

// version 子命令：标准输出只有一行“codex-harness-adapter <版本号>”。客户端拿它判断命令在不在、是哪一版。
func runVersion(args []string) error {
	if len(args) != 0 {
		return errors.New(tr("version 不接受参数", "version takes no arguments"))
	}
	root, err := executableRoot()
	if err != nil {
		return err
	}
	fmt.Println("codex-harness-adapter " + adapterVersion(root))
	return nil
}
