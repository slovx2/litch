//go:build !windows

package hostplatform

import (
	"os/exec"
	"runtime"
	"strings"
)

// SystemLanguage 返回系统界面的首选语言（如 zh-Hans-CN），取不到时返回空串。
// macOS 上由 launchd 拉起的后台服务没有 LANG，只能问系统；Linux 以环境变量为准，这里不再另查。
func SystemLanguage() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	output, err := exec.Command("/usr/bin/defaults", "read", "-g", "AppleLanguages").Output()
	if err != nil {
		return ""
	}
	// 输出是一个列表：( "zh-Hans-CN", "en-CN" )，第一项就是首选语言。
	for _, line := range strings.Split(string(output), "\n") {
		if tag := strings.Trim(strings.TrimSpace(line), `",`); tag != "" && tag != "(" && tag != ")" {
			return tag
		}
	}
	return ""
}
