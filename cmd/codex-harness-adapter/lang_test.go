package main

import (
	"strings"
	"testing"
)

func TestDetectLanguage(t *testing.T) {
	cases := []struct {
		name   string
		env    map[string]string
		system string
		want   language
	}{
		{"什么都没有时用英文", nil, "", english},
		{"LANG 是中文", map[string]string{"LANG": "zh_CN.UTF-8"}, "", chinese},
		{"LANG 是英文时不再问系统", map[string]string{"LANG": "en_US.UTF-8"}, "zh-Hans-CN", english},
		{"C 和 POSIX 不算偏好，接着问系统", map[string]string{"LANG": "C.UTF-8", "LC_ALL": "POSIX"}, "zh-Hans-CN", chinese},
		{"LC_ALL 压过 LANG", map[string]string{"LC_ALL": "zh_TW.UTF-8", "LANG": "en_US.UTF-8"}, "", chinese},
		{"LANGUAGE 取第一项", map[string]string{"LANGUAGE": "zh_CN:en", "LANG": "en_US.UTF-8"}, "", chinese},
		{"CHA_LANG 压过一切", map[string]string{"CHA_LANG": "en", "LC_ALL": "zh_CN.UTF-8"}, "zh-Hans-CN", english},
		{"CHA_LANG 写 zh-CN", map[string]string{"CHA_LANG": "zh-CN", "LANG": "en_US.UTF-8"}, "", chinese},
		{"环境变量没有时跟随系统", nil, "zh-Hans-US", chinese},
		{"系统是别的语言时用英文", nil, "ja-JP", english},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := detectLanguage(func(name string) string { return c.env[name] }, func() string { return c.system })
			if got != c.want {
				t.Fatalf("得到 %v，应为 %v", got, c.want)
			}
		})
	}
}

func TestUserEnvironmentLanguage(t *testing.T) {
	t.Cleanup(func() { outputLanguage = chinese })

	// 环境文件里写了就用它。
	t.Setenv("CHA_LANG", "")
	outputLanguage = chinese
	applyUserLanguage(map[string]string{"CHA_LANG": "en"})
	if outputLanguage != english {
		t.Fatal("环境文件里的 CHA_LANG 没有生效")
	}

	// 进程环境里也设了，以进程环境为准，环境文件不再改它。
	t.Setenv("CHA_LANG", "en")
	outputLanguage = english
	applyUserLanguage(map[string]string{"CHA_LANG": "zh-CN"})
	if outputLanguage != english {
		t.Fatal("环境文件不应压过进程环境里的 CHA_LANG")
	}

	// 环境文件里的值认不出来时保持原样。
	t.Setenv("CHA_LANG", "")
	outputLanguage = chinese
	applyUserLanguage(map[string]string{"CHA_LANG": ""})
	if outputLanguage != chinese {
		t.Fatal("空值不应改变输出语言")
	}
}

// Homebrew 配方的自检按子命令清单匹配帮助文本，两种语言都得原样带着它。
func TestUsageKeepsCommandListInBothLanguages(t *testing.T) {
	t.Cleanup(func() { outputLanguage = chinese })
	const commands = "codex-harness-adapter start|init|serve|ssh-config|doctor"
	for _, lang := range []language{chinese, english} {
		outputLanguage = lang
		if !strings.Contains(usage(), commands) {
			t.Fatalf("帮助文本缺少子命令清单：%q", usage())
		}
	}
	outputLanguage = english
	if !strings.HasPrefix(usage(), "Usage: ") || strings.Contains(usage(), "用法") {
		t.Fatalf("英文帮助文本不对：%q", usage())
	}
}
