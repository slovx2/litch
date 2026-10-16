package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 命令行输出的语言，中文和英文两种。判断顺序：
// CHA_LANG（进程环境，其次环境文件）→ LANGUAGE、LC_ALL、LC_MESSAGES、LANG → 系统界面语言 → 英文。
// 引擎进程写进日志的内容、经协议发给客户端的提示不归这里管。
type language int

const (
	english language = iota
	chinese
)

var outputLanguage = detectLanguage(os.Getenv, hostplatform.SystemLanguage)

// tr 按当前语言二选一。两种文案写在同一处，改其中一种时不会漏掉另一种。
func tr(zh, en string) string {
	if outputLanguage == chinese {
		return zh
	}
	return en
}

// bilingual 是同一句话的两种语言版本。经协议发给客户端的字两种都带上，由客户端按自己的语言取；
// 命令行自己打印时用 String 按当前的输出语言取一种。
type bilingual struct {
	ZH string `json:"zh-CN"`
	EN string `json:"en"`
}

func both(zh, en string) bilingual { return bilingual{ZH: zh, EN: en} }

// 没有两种写法的原话（系统给的错误文字等），两边放同一句。
func verbatim(text string) bilingual { return bilingual{ZH: text, EN: text} }

func (b bilingual) String() string { return tr(b.ZH, b.EN) }

func (b bilingual) with(args ...any) bilingual {
	return bilingual{ZH: fmt.Sprintf(b.ZH, args...), EN: fmt.Sprintf(b.EN, args...)}
}

// pair 和 with 一样往里填，只是填进去的东西本身也分两种语言：中文那句填中文的，英文那句填英文的。
func (b bilingual) pair(args ...bilingual) bilingual {
	zh, en := make([]any, len(args)), make([]any, len(args))
	for index, arg := range args {
		zh[index], en[index] = arg.ZH, arg.EN
	}
	return bilingual{ZH: fmt.Sprintf(b.ZH, zh...), EN: fmt.Sprintf(b.EN, en...)}
}

// parseLanguage 认 zh-CN、zh_CN.UTF-8、en_US 这类写法。空值和 C、POSIX 表示“没有偏好”，返回 false。
func parseLanguage(tag string) (language, bool) {
	tag = strings.ToLower(strings.TrimSpace(tag))
	// LANGUAGE 可以是冒号分隔的一串，取第一个；再去掉编码和修饰（.UTF-8、@pinyin）。
	tag, _, _ = strings.Cut(tag, ":")
	if cut := strings.IndexAny(tag, ".@"); cut >= 0 {
		tag = tag[:cut]
	}
	switch {
	case tag == "" || tag == "c" || tag == "posix":
		return english, false
	case tag == "zh" || strings.HasPrefix(tag, "zh-") || strings.HasPrefix(tag, "zh_"):
		return chinese, true
	}
	return english, true
}

func detectLanguage(getenv func(string) string, system func() string) language {
	for _, name := range []string{"CHA_LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"} {
		if detected, ok := parseLanguage(getenv(name)); ok {
			return detected
		}
	}
	detected, _ := parseLanguage(system())
	return detected
}

// 后台服务拿不到终端里的环境变量，所以环境文件里的 CHA_LANG 也算数；进程环境里设了的话以进程环境为准。
func applyUserLanguage(userEnv map[string]string) {
	if _, ok := parseLanguage(os.Getenv("CHA_LANG")); ok {
		return
	}
	if detected, ok := parseLanguage(userEnv["CHA_LANG"]); ok {
		outputLanguage = detected
	}
}
