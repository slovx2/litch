// 示例组装入口；宿主可把同一调用嵌入自己的可执行文件，不需要完整 Litch CLI。
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/slovx2/litch-automation/chromebridge"
)

func main() {
	if err := chromebridge.Run(context.Background(), os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
