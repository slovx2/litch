// Package protocol 把仓库根目录 protocol/ 里给 Go 用的数据交给命令行：现在只有 versions.json（验证过的版本）。
// 这个目录的主体是协议的结构定义和扩展说明；Go 只取 versions.json，编译时嵌进二进制，运行时不找文件。
package protocol

import (
	_ "embed"
	"encoding/json"
)

// 我们验证过的各个上游版本。CI 照它装，适配器的“给设备装 harness”拿它当验证版（harness_install.go）。
//
//go:embed versions.json
var versionsData []byte

// Verified 返回 versions.json 里某个键记的版本：值是字符串就是它，是数组就取最后一个（最新验证的那一版）。
// 没有这个键、值不是版本号，返回空串。
func Verified(key string) string {
	var table map[string]json.RawMessage
	if err := json.Unmarshal(versionsData, &table); err != nil {
		// 随二进制编进来的数据解不开，只可能是那个文件被改坏了，直接让进程起不来
		panic("protocol/versions.json: " + err.Error())
	}
	raw, found := table[key]
	if !found {
		return ""
	}
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil && len(list) > 0 {
		return list[len(list)-1]
	}
	return ""
}
