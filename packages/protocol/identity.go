// Package protocol 把 packages/protocol 里两种语言共用的数据交给 Go 这一侧。
// 这个目录的主体是 TypeScript 写的协议类型；Go 只取其中的数据文件，编译时嵌进二进制，运行时不找文件。
package protocol

import (
	_ "embed"
	"encoding/json"
)

// 各 harness 给人看的名字和徽标只写在这一个文件里，引擎和设备进程（TypeScript）读的也是它，
// 见 src/harness-identity.mts。
//
//go:embed src/harness-identity.json
var harnessIdentityData []byte

// HarnessIdentity 是一个 harness 给人看的名字和两个字母的徽标。
type HarnessIdentity struct {
	DisplayName string `json:"displayName"`
	Badge       string `json:"badge"`
}

// HarnessIdentities 返回各 harness 的名字和徽标，键是 harness 的标识。
// 数据是随二进制编进来的，解不开只可能是那个文件被改坏了，直接让进程起不来。
func HarnessIdentities() map[string]HarnessIdentity {
	identities := map[string]HarnessIdentity{}
	if err := json.Unmarshal(harnessIdentityData, &identities); err != nil {
		panic("packages/protocol/src/harness-identity.json: " + err.Error())
	}
	return identities
}
