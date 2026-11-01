// Litch 的入口胶水；上游 claudetui 保持原样，绝不退回非交互模式。
package main

import (
	"fmt"
	"os"

	"github.com/yetone/magpie/internal/claudetui"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hook" {
		os.Exit(runHook(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if err := mcp(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	os.Setenv(claudetui.OnlyEnv, "1")
	if err := claudetui.Run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
