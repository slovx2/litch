//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// 语言环境还是 C 的时候，给终端里的命令补一个用 UTF-8 的 LC_CTYPE。
//
// 这件事原来的桥（python 写的）代码里没有，是 Python 解释器启动时自己做的（PEP 538），顺着环境传给了命令。
// 常驻服务常常没有语言环境（brew services、从访达打开的应用、容器），少了它终端里的中文文件名是一串问号，
// shell 的行编辑也把一个汉字当成几个字符。规矩照 Python 的：
//   - LC_ALL 有值就不动：它压着 LC_CTYPE，补了也没用；
//   - 管字符类别的那一项（LC_CTYPE，没有就看 LANG）没设或者是 C 才补；Linux 上 POSIX 是 C 的别名，也算；
//   - 补的是这台机器上有的头一个，先 C.UTF-8，再 UTF-8（没有 C.UTF-8 的 macOS 上是它）。
//
// Python 是让系统的 C 库试出来有没有的；这里不用 cgo，没有 C 库可问，改成看语言环境的文件在不在。
// 另有一种情况认不出来：写了一个这台机器上没有的语言环境，Python 也会补，这里不补。
var ptyUTF8Locales = []struct{ name, marker string }{
	{"C.UTF-8", "/usr/share/locale/C.UTF-8/LC_CTYPE"}, // macOS、BSD
	{"C.UTF-8", "/usr/lib/locale/C.utf8/LC_CTYPE"},    // glibc
	{"C.UTF-8", "/usr/lib/locale/C.UTF-8/LC_CTYPE"},   // glibc，早些的 Debian 用这个目录名
	{"UTF-8", "/usr/share/locale/UTF-8/LC_CTYPE"},     // 没有 C.UTF-8 的 macOS
}

// 这台机器上能用的 UTF-8 语言环境的名字，没有就是空的。
func ptyUTF8Locale() string {
	for _, candidate := range ptyUTF8Locales {
		if info, err := os.Stat(candidate.marker); err == nil && !info.IsDir() {
			return candidate.name
		}
	}
	// musl 没有语言环境的文件，什么名字它都认，C 之外的一律是 UTF-8。
	if found, _ := filepath.Glob("/lib/ld-musl-*.so.1"); len(found) > 0 {
		return "C.UTF-8"
	}
	return ""
}

// 该补的话返回要补的值，不该补返回空的。
func ptyCoercedLocale(getenv func(string) string, goos string, available func() string) string {
	if getenv("LC_ALL") != "" {
		return ""
	}
	current := getenv("LC_CTYPE")
	if current == "" {
		current = getenv("LANG")
	}
	if current != "" && current != "C" && (goos != "linux" || current != "POSIX") {
		return ""
	}
	return available()
}

// 交给命令的环境：原样继承桥自己的，只在上面说的那种情况下换掉（或者添上）LC_CTYPE。
func ptyCommandEnvironment() []string {
	environment := os.Environ()
	locale := ptyCoercedLocale(os.Getenv, runtime.GOOS, ptyUTF8Locale)
	if locale == "" {
		return environment
	}
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(entry, "LC_CTYPE=") {
			result = append(result, entry)
		}
	}
	return append(result, "LC_CTYPE="+locale)
}
