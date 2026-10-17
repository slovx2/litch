package main

import (
	"bytes"
	"encoding/json"
	"math"
	"path/filepath"
	"sort"
	"strings"
)

// 写进来的值怎么校验、存成什么形状，读出去时怎么遮住密钥。

const (
	settingTextLimit  = 4096
	settingValueLimit = 32 * 1024
	settingEnvLimit   = 200
)

// 适配器自己定死的环境变量：每个运行时的状态目录靠它们隔开，命令行自己的路径也在里面，不许在设置里改。
// 各引擎的状态目录变量出自登记表（harness_table.go），和 environment() 给的是同一份。
var fixedEnvironmentNames = func() []string {
	names := []string{"CODEX_HOME", "CHA_CLAUDE_IDLE_EXIT_MS", adapterCLIEnvironment, acpAgentVariable}
	for _, spec := range harnessTable {
		if spec.homeVariable != "" {
			names = append(names, spec.homeVariable)
		}
	}
	return names
}()

func isFixedEnvironmentName(name string) bool {
	for _, fixed := range fixedEnvironmentNames {
		if fixed == name {
			return true
		}
	}
	return false
}

func wrongType(spec settingSpec, zh, en string) *settingsProblem {
	return invalidSetting(spec.Key, both("这一项要填"+zh, "This setting takes "+en))
}

func encodeSetting(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

// normalizeSetting 把写进来的值变成存盘的形状。返回 nil 表示清掉这一项，回到默认值。
// previous 是这一项原来存的值：环境变量表里不带值的密钥要从它那里接着用。
func normalizeSetting(spec settingSpec, value, previous json.RawMessage) (json.RawMessage, *settingsProblem) {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	switch spec.Type {
	case settingBoolean:
		var flag bool
		if json.Unmarshal(trimmed, &flag) != nil {
			return nil, wrongType(spec, "开或关", "on or off")
		}
		return encodeSetting(flag), nil
	case settingInteger:
		var number float64
		if json.Unmarshal(trimmed, &number) != nil || number != math.Trunc(number) || math.Abs(number) > 1<<31 {
			return nil, wrongType(spec, "整数", "a whole number")
		}
		if spec.Minimum != nil && int(number) < *spec.Minimum {
			return nil, invalidSetting(spec.Key, both("不能小于 %d", "Must be at least %d").with(*spec.Minimum))
		}
		if spec.Maximum != nil && int(number) > *spec.Maximum {
			return nil, invalidSetting(spec.Key, both("不能大于 %d", "Must be at most %d").with(*spec.Maximum))
		}
		return encodeSetting(int(number)), nil
	case settingEnv:
		return normalizeEnvironment(spec, trimmed, previous)
	}
	var text string
	if json.Unmarshal(trimmed, &text) != nil {
		return nil, wrongType(spec, "文字", "text")
	}
	if strings.ContainsRune(text, 0) {
		return nil, invalidSetting(spec.Key, both("里面有不能用的字符", "It contains a character that cannot be used"))
	}
	switch spec.Type {
	case settingEnum:
		for _, option := range spec.Options {
			if option.Value == text {
				return encodeSetting(text), nil
			}
		}
		return nil, invalidSetting(spec.Key, both("不在可选的值里", "Not one of the available choices"))
	case settingSecret:
		if len(text) > settingValueLimit {
			return nil, invalidSetting(spec.Key, both("太长了", "Too long"))
		}
	case settingPath:
		if text != "" && !filepath.IsAbs(text) {
			return nil, invalidSetting(spec.Key, both("要写绝对路径", "Must be an absolute path"))
		}
		fallthrough
	default:
		if len(text) > settingTextLimit || strings.ContainsAny(text, "\r\n") {
			return nil, invalidSetting(spec.Key, both("太长了，或者里面有换行", "Too long, or it contains a line break"))
		}
	}
	// 空着就是没填，和清掉是一回事。
	if text == "" {
		return nil, nil
	}
	return encodeSetting(text), nil
}

func normalizeEnvironment(spec settingSpec, value, previous json.RawMessage) (json.RawMessage, *settingsProblem) {
	var entries []envEntry
	if json.Unmarshal(value, &entries) != nil {
		return nil, wrongType(spec, "环境变量表", "a list of environment variables")
	}
	if len(entries) > settingEnvLimit {
		return nil, invalidSetting(spec.Key, both("变量太多了，最多 %d 个", "Too many variables; the limit is %d").with(settingEnvLimit))
	}
	kept := map[string]string{}
	var stored []envEntry
	if json.Unmarshal(previous, &stored) == nil {
		for _, entry := range stored {
			if entry.Secret && entry.Value != nil {
				kept[entry.Name] = *entry.Value
			}
		}
	}
	seen := map[string]bool{}
	result := make([]envEntry, 0, len(entries))
	for _, entry := range entries {
		switch {
		case !environmentName.MatchString(entry.Name):
			return nil, invalidSetting(spec.Key, both("变量名 %q 不合规矩，只能用字母、数字和下划线，不能以数字开头", "The variable name %q is not valid: letters, digits and underscores only, not starting with a digit").with(entry.Name))
		// 原生 codex 没有适配器定死的变量：它的数据目录本来就归用户，CODEX_HOME 可以在这里设。
		case spec.Scope.Harness != nativeCodex && isFixedEnvironmentName(entry.Name):
			return nil, invalidSetting(spec.Key, both("%s 由适配器自己设定，不能改", "%s is set by the adapter itself and cannot be changed").with(entry.Name))
		case seen[entry.Name]:
			return nil, invalidSetting(spec.Key, both("变量 %s 出现了两次", "The variable %s appears twice").with(entry.Name))
		}
		seen[entry.Name] = true
		entry.Secret = entry.Secret || secretLikeName.MatchString(entry.Name)
		if entry.Value == nil {
			// 密钥读不回去，界面改别的变量时只能把它原样带回来：不带值就是接着用原来的。
			old, had := kept[entry.Name]
			if !entry.Secret || !had {
				return nil, invalidSetting(spec.Key, both("变量 %s 没有给值", "The variable %s has no value").with(entry.Name))
			}
			entry.Value = &old
		}
		if len(*entry.Value) > settingValueLimit || strings.ContainsRune(*entry.Value, 0) {
			return nil, invalidSetting(spec.Key, both("变量 %s 的值太长，或者里面有不能用的字符", "The value of %s is too long, or contains a character that cannot be used").with(entry.Name))
		}
		result = append(result, entry)
	}
	if len(result) == 0 {
		return nil, nil
	}
	return encodeSetting(result), nil
}

// presentSetting 是读设置时看到的值：没写过（或者文件里那一项被手工改坏了）就是默认值；
// 密钥只说设没设过，环境变量表里的密钥不带值。
func presentSetting(spec settingSpec, raw json.RawMessage, written bool) any {
	switch spec.Type {
	case settingSecret:
		return map[string]bool{"set": written}
	case settingEnv:
		entries := []envEntry{}
		var stored []envEntry
		if written && json.Unmarshal(raw, &stored) == nil {
			for _, entry := range stored {
				if entry.Secret {
					entry.Value = nil
				}
				entries = append(entries, entry)
			}
		}
		return entries
	case settingBoolean:
		var flag bool
		if written && json.Unmarshal(raw, &flag) == nil {
			return flag
		}
	case settingInteger:
		var number int
		if written && json.Unmarshal(raw, &number) == nil {
			return number
		}
	default:
		var text string
		if written && json.Unmarshal(raw, &text) == nil {
			return text
		}
	}
	return spec.Default
}

// 环境文件里的变量：对每个 harness 都生效，优先级在设置之下。读设置时一并给出，界面上只读。
type inheritedEnvEntry struct {
	Name   string  `json:"name"`
	Value  *string `json:"value,omitempty"`
	Secret bool    `json:"secret"`
}

func inheritedEnvironment(userEnv map[string]string) []inheritedEnvEntry {
	names := make([]string, 0, len(userEnv))
	for name := range userEnv {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]inheritedEnvEntry, 0, len(names))
	for _, name := range names {
		entry := inheritedEnvEntry{Name: name, Secret: secretLikeName.MatchString(name)}
		if !entry.Secret {
			value := userEnv[name]
			entry.Value = &value
		}
		entries = append(entries, entry)
	}
	return entries
}
