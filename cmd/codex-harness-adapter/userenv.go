package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// 用户环境文件位于状态根目录下的 env：每行 KEY=VALUE，空行和 # 开头的行忽略。
// brew services 等后台方式无法继承终端环境，统一从这里读取适配器与引擎配置。
// 优先级：适配器固定变量 > 启动进程已有变量 > 环境文件。值按字面使用，不做变量展开。
const userEnvironmentFile = "env"

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func userEnvironmentPath(home string) string { return filepath.Join(home, userEnvironmentFile) }

func loadUserEnvironment(home string) (map[string]string, error) {
	path := userEnvironmentPath(home)
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf(tr("无法读取环境文件 %s: %w", "cannot read the environment file %s: %w"), path, err)
	}
	defer file.Close()
	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		name, value, found := strings.Cut(strings.TrimPrefix(text, "export "), "=")
		name = strings.TrimSpace(name)
		if !found || !environmentName.MatchString(name) {
			return nil, fmt.Errorf(tr("环境文件 %s 第 %d 行格式无效，应为 KEY=VALUE", "environment file %s, line %d: invalid format, expected KEY=VALUE"), path, line)
		}
		values[name] = unquote(strings.TrimSpace(value))
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf(tr("无法读取环境文件 %s: %w", "cannot read the environment file %s: %w"), path, err)
	}
	return values, nil
}

// 去掉成对的外层引号，便于直接粘贴 shell 中的写法。
func unquote(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1]
	}
	return value
}
