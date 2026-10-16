//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 什么时候给命令补 LC_CTYPE：照 Python 解释器（PEP 538）的规矩，原来的桥靠它才让终端里的中文正常。
func TestPtyCoercedLocaleFollowsPythonRules(t *testing.T) {
	available := func() string { return "C.UTF-8" }
	cases := []struct {
		name        string
		environment map[string]string
		goos        string
		want        string
	}{
		{"什么都没设", nil, "darwin", "C.UTF-8"},
		{"LANG 是 C", map[string]string{"LANG": "C"}, "darwin", "C.UTF-8"},
		{"LANG 是空的", map[string]string{"LANG": ""}, "linux", "C.UTF-8"},
		{"LC_CTYPE 是 C，压着 LANG", map[string]string{"LC_CTYPE": "C", "LANG": "en_US.UTF-8"}, "linux", "C.UTF-8"},
		{"别的类别不算", map[string]string{"LC_MESSAGES": "en_US.UTF-8"}, "linux", "C.UTF-8"},
		{"LC_ALL 是空的等于没设", map[string]string{"LC_ALL": ""}, "darwin", "C.UTF-8"},
		{"LC_ALL 有值就不动", map[string]string{"LC_ALL": "C"}, "linux", ""},
		{"LC_ALL 压着 LANG", map[string]string{"LC_ALL": "en_US.UTF-8", "LANG": "C"}, "linux", ""},
		{"已经有语言环境", map[string]string{"LANG": "zh_CN.UTF-8"}, "darwin", ""},
		{"LC_CTYPE 有值", map[string]string{"LC_CTYPE": "en_US.UTF-8", "LANG": "C"}, "linux", ""},
		// POSIX 在 Linux 上是 C 的别名，在 macOS 上不是。
		{"Linux 上的 POSIX", map[string]string{"LANG": "POSIX"}, "linux", "C.UTF-8"},
		{"macOS 上的 POSIX", map[string]string{"LANG": "POSIX"}, "darwin", ""},
	}
	for _, item := range cases {
		getenv := func(name string) string { return item.environment[name] }
		if got := ptyCoercedLocale(getenv, item.goos, available); got != item.want {
			t.Errorf("%s：得到 %q，应为 %q", item.name, got, item.want)
		}
	}
	// 这台机器上没有能用的 UTF-8 语言环境就不补：补一个不存在的，命令会各自报警告。
	if got := ptyCoercedLocale(func(string) string { return "" }, "linux", func() string { return "" }); got != "" {
		t.Errorf("没有可用的语言环境时仍然补了 %q", got)
	}
}

// 真的跑一遍：语言环境是 C 时命令看到的 LC_CTYPE 换成了这台机器上有的那个，别的变量一个不动；
// 已经有语言环境时原样不动。
func TestPtyBridgeCoercesLocaleForCommand(t *testing.T) {
	script := `echo "ctype=[$LC_CTYPE] lang=[$LANG] all=[${LC_ALL-unset}] keep=[$KEEP]"`
	run := func(environment ...string) string {
		bridge := startPtyBridge(t, append([]string{"KEEP=原样"}, environment...), "", "--", "/bin/sh", "-c", script)
		bridge.pid()
		if code, _ := bridge.exit(10 * time.Second); code != 0 {
			t.Fatalf("退出码是 %d，输出 %q", code, bridge.text())
		}
		return bridge.text()
	}
	// 这台机器上没有可用的 UTF-8 语言环境时，补的就是空的：那样原来的值也不动。
	coerced := ptyUTF8Locale()
	if coerced == "" {
		coerced = "C"
	}
	if got, want := run("LC_ALL=", "LC_CTYPE=C", "LANG=C"), "ctype=["+coerced+"] lang=[C] all=[] keep=[原样]\n"; got != want {
		t.Errorf("语言环境是 C 时：%q，应为 %q", got, want)
	}
	if got, want := run("LC_ALL=", "LC_CTYPE=", "LANG=zh_CN.UTF-8"), "ctype=[] lang=[zh_CN.UTF-8] all=[] keep=[原样]\n"; got != want {
		t.Errorf("已经有语言环境时：%q，应为 %q", got, want)
	}
	if got, want := run("LC_ALL=C", "LC_CTYPE=C", "LANG=C"), "ctype=[C] lang=[C] all=[C] keep=[原样]\n"; got != want {
		t.Errorf("LC_ALL 有值时：%q，应为 %q", got, want)
	}
}

// 命令照 execvp 的规矩找：带斜杠的原样用；PATH 没设时找 /bin 和 /usr/bin；空的一项和点都是当前目录；
// 同名而用不了的跳过，全都用不了时报的是“不让用”，不是“没有这个文件”。
func TestLookPtyCommandFollowsExecvp(t *testing.T) {
	directory := t.TempDir()
	write := func(path string, mode os.FileMode) string {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	blocked := write(filepath.Join(directory, "blocked", "tool"), 0o600)
	usable := write(filepath.Join(directory, "usable", "tool"), 0o700)
	if err := os.MkdirAll(filepath.Join(directory, "shadow", "tool"), 0o700); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(directory, "here"), 0o700)
	t.Chdir(directory)

	look := func(search *string, name string) (string, error) {
		if search == nil {
			original, had := os.LookupEnv("PATH")
			_ = os.Unsetenv("PATH")
			defer func() {
				if had {
					_ = os.Setenv("PATH", original)
				}
			}()
		} else {
			t.Setenv("PATH", *search)
		}
		return lookPtyCommand(name)
	}
	text := func(value string) *string { return &value }
	join := func(parts ...string) *string { return text(strings.Join(parts, ":")) }

	if path, err := look(text("/nowhere"), "relative/path/tool"); err != nil || path != "relative/path/tool" {
		t.Errorf("带斜杠的名字被改了: %q %v", path, err)
	}
	if path, err := look(nil, "sh"); err != nil || (path != "/bin/sh" && path != "/usr/bin/sh") {
		t.Errorf("PATH 没设时没有去默认的目录里找: %q %v", path, err)
	}
	if path, err := look(join(filepath.Dir(blocked), filepath.Join(directory, "shadow"), filepath.Dir(usable)), "tool"); err != nil || path != usable {
		t.Errorf("没有跳过用不了的同名文件和目录: %q %v", path, err)
	}
	if _, err := look(join(filepath.Dir(blocked), "/nowhere"), "tool"); !errors.Is(err, syscall.EACCES) {
		t.Errorf("只有用不了的同名文件时应当报不让用: %v", err)
	}
	if _, err := look(text("/nowhere:/also/nowhere"), "tool"); !errors.Is(err, syscall.ENOENT) {
		t.Errorf("哪儿都没有时应当报没有这个文件: %v", err)
	}
	for _, search := range []*string{text(""), join("", "/nowhere"), join("/nowhere", ""), join(".", "/nowhere")} {
		if path, err := look(search, "here"); err != nil || path != "./here" && path != "here" {
			t.Errorf("PATH=%q 时没有在当前目录里找到: %q %v", *search, path, err)
		}
	}
}
