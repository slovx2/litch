# Chrome Native Messaging 转发库

宿主可导入 `github.com/slovx2/litch/chromebridge`，在自己的 Go 命令入口调用：

```go
if err := chromebridge.Run(ctx, os.Args[1:], os.Stdin, os.Stdout); err != nil {
    fmt.Fprintln(os.Stderr, err)
    os.Exit(1)
}
```

参数：`--config /绝对路径/native-config.json chrome-extension://<扩展ID>/`，Windows 可追加 Chrome 传入的 `--parent-window=<数字>`。配置包含 socketPath、64 字符 token、extensionIds；不默认信任任何扩展。macOS/Linux 配置须为私有普通文件，拒绝符号链接、超过 8192 字节或可被其他用户读写的配置。Windows 依赖宿主安装目录 ACL。

库不写系统登记；host 名由 Node/使用方的 manifest 决定。现 CHA 的 `chrome-host` 子命令只是同一个 Run 的组装入口。Go 模块依赖与工具链沿根 go.mod 精确版本；第三方 pin 与 tarball 对应提交/正式 tag，不跟浮动分支。

Native Messaging 为 4 字节小端长度+JSON（扩展→桥上限 16 MiB），本机桥为 JSONL（桥→扩展上限 512 KiB）。初次连接发 nativeHello，绑定 token 和 Chrome 传入的 origin；此后只转帧。扩展协议 1 的协商、lease/epoch、网站权限和文档代次由 Node/扩展端执行，Go 不执行网页或模型命令。

Run 任一方向 EOF、错误或 ctx 取消后关闭本机连接并返回；拥有输入流的宿主同时负责关闭阻塞 reader/结束自己的命令进程。NativeToBridge/BridgeToNative 可单独用于受控流。测试 `go test ./chromebridge` 覆盖帧与调用来源；完整隔离 Native Messaging 链路由 Chrome E2E 验证。Windows 实机和正式商店安装不由单元测试证明。

按仓库 MIT LICENSE 分发。标准输入/输出仅用于协议，诊断写标准错误。
