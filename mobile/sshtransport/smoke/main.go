// 在电脑上直接调手机端 SSH 模块的小工具，给 apps/mobile/scripts/ssh-smoke.mjs 用：
// 不用装到手机上，就能对着测试夹具验 RunScript、OpenStream 这几步。
// 标准输入一行一个 JSON 命令，标准输出一行一个 JSON 结果：
//
//	{"op":"run","target":{...},"script":"...","marker":"..."}
//	{"op":"open","id":"a","target":{...},"script":"...","marker":"..."}
//	{"op":"state","id":"a"}
//	{"op":"close","id":"a"}
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/slovx2/litch/mobile/sshtransport"
)

type command struct {
	Op     string          `json:"op"`
	ID     string          `json:"id"`
	Target json.RawMessage `json:"target"`
	Script string          `json:"script"`
	Marker string          `json:"marker"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		var c command
		if err := json.Unmarshal(scanner.Bytes(), &c); err != nil {
			reply("", err)
			continue
		}
		switch c.Op {
		case "run":
			reply(sshtransport.RunScript(string(c.Target), c.Script, c.Marker))
		case "open":
			reply(sshtransport.OpenStream(c.ID, string(c.Target), c.Script, c.Marker))
		case "state":
			reply(sshtransport.StreamState(c.ID))
		case "close":
			sshtransport.CloseStream(c.ID)
			reply("{}", nil)
		default:
			reply("", fmt.Errorf("不认识的命令 %q", c.Op))
		}
	}
}

func reply(result string, err error) {
	if err != nil {
		encoded, _ := json.Marshal(map[string]string{"error": err.Error()})
		fmt.Println(string(encoded))
		return
	}
	fmt.Println(result)
}
