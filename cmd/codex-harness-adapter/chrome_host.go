package main

import (
	"context"
	"os"

	"github.com/slovx2/litch/chromebridge"
)

// 命令入口只组装标准输入输出；通用转发实现由宿主复用。
func runChromeHost(ctx context.Context, args []string) error {
	return chromebridge.Run(ctx, args, os.Stdin, os.Stdout)
}
