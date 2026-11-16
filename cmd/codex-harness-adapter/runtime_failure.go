package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// 只认本轮进程输出里的固定本地传输错误；不把配置、模型输出或凭据所在的整段 stderr 送给客户端。
func runtimeFailureText(c configuration, path string, offset int64, message bilingual, cause error) bilingual {
	detail := ""
	if c.native() {
		if file, err := os.Open(path); err == nil {
			defer file.Close()
			if stat, err := file.Stat(); err == nil {
				start := max(offset, stat.Size()-8192)
				data, _ := io.ReadAll(io.NewSectionReader(file, start, 8192))
				for _, known := range []string{
					"socket directory is not private to the current user",
					"untrusted socket directory",
					"path must be shorter than SUN_LEN",
				} {
					if strings.Contains(string(data), "Error: "+known) {
						detail = known
						break
					}
				}
			}
		}
	}
	if detail == "" && cause != nil {
		detail = cause.Error()
	}
	if detail == "" {
		return message
	}
	return both(fmt.Sprintf("%s：%s", message.ZH, detail), fmt.Sprintf("%s: %s", message.EN, detail))
}
