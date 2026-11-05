# 手机内嵌网络接口

Go `1.27.3`、`tailscale.com v1.104.1`，同一个 gomobile 库承载原有 SSH 与 tsnet。
不使用系统 VPN，不实现 Tailscale SSH；认证仍由 `x/crypto/ssh` 的私钥和固定主机指纹完成。

## 原生桥约定

- `TailscaleInitialize(directory, hostname string, storage TailscaleStorage) error`：应用启动时调用，
  不联网。目录为节点专用私有目录，清除状态时会删除。不能传整个应用文档目录。
- `TailscaleStorage.Read() (string,error)`：没有状态返回空串。
- `TailscaleStorage.Write(state string) error`：同步、原子、加密落盘，失败必须返回错误。
- `TailscaleStorage.Clear() error`：删除密文与原生加密密钥。
- 以上存储 JSON 含节点秘密，不经过 JS；原生回调不得重入 Go。Go 持锁调用存储。
- `TailscaleLogin(controlURL string) (string,error)`：空为官方控制面；否则仅 HTTPS。
  发起登录后立即返回状态，不等待用户认证。控制服务器变化前必须清除旧身份。
- `TailscaleStatus() (string,error)`：查询本地状态，通常不联网；从后台暂停恢复时可重启节点。
- `TailscaleLogout() error`、`TailscaleClear() error`、`TailscaleStop() error`：退出、清状态、
  仅停止。退出/清状态取消所有内嵌连接及正在拨号的请求；普通 SSH 不受影响。

状态 JSON：`{state,hostname,tailnet,authURL,controlURL}`。
`state` 为 `stopped|starting|needsLogin|needsApproval|connected|suspended`。
登录 URL 可能稍后出现，前台设置页限时查询后自动打开系统浏览器。只返回 HTTPS 登录 URL。
读取完成前界面显示正在读取；冷启动读取已启用的存储后，首次状态查询恢复节点。
错误带 `[tailscaleLogin]` 等种类，UI 映射中英文；不要向界面输出原生秘密或网络调试日志。

`Target` JSON 的可选 `tailscale:"auto"|"always"|"never"` 决定网络（省略为自动）；`ProbeHost(host,port,user,mode)`
也必须传同一个选择；`ConnectionRoute(host,port,mode)` 返回最近实际选择的 system/tailscale。其余 SSH 导出方法签名不变。脚本、长流、登记、升级都经过 `connectSSH`。

## Android 网络与存储

在首次创建节点前调用 `SetTailscaleInterfaces(encoded string) error`，之后网络切换再调用：

```json
[{"index":1,"name":"eth0","mtu":1500,"up":true,"loopback":false,"pointToPoint":false,"multicast":true,"addresses":["192.0.2.2/24"]}]
```

数据必须由 Android 公开平台 API 获取。Go 注册 `netmon.RegisterInterfaceGetter` 并触发网络
重新采样，避开 Android 普通应用无法使用的 netlink。不要传假接口或忽略解析失败。
Android 还需通过 `SetTailscaleDefaultRouteInterface(name)` 提供默认接口。
默认网络和底层网络集合变化时调用 `TailscaleNetworkChanged(identity,available)`；仅更新地址快照会漏掉
VPN 接口地址不变的切网。iOS 通过 NWPathMonitor 调同一入口。它重绑 UDP/DERP 并重新探测，
先关闭旧网络上的 DERP（缺少默认接口 IP 时仅调用 Rebind 不会关掉它），不启动或重建节点；
重复 identity 不生效。与 netstack 拨号一样使用固定版本的 tsnet Sys 接口。
Android 原生实现用 Keystore AES-256-GCM、每次随机 IV、固定 AAD 和 AtomicFile；密文在
`noBackupFilesDir`，不随设备备份。iOS 用同一个存储接口接 Keychain 与平台文件保护。

`SetAppBackground`、`BackgroundDeadline` 共用原有连接暂停策略。系统允许提前到期；
不以实际经过五分钟为前提。暂停关闭节点和连接，前台的下一次拨号或状态查询恢复。
交互登录为节点保留最多十分钟的后台认证窗口；SSH gate 仍按原期限关闭。

## 不允许公网回退

此版本的官方 `Server.Dial` 对不在 peer map 的地址可能回退系统 `net.Dialer`，网络图变化也
可能产生检查与拨号间的竞态。因此先把 MagicDNS 解析成网络图中的 IP，再调用该固定版本
`Server.Sys().Dialer.Get().NetstackDialTCP`。只接受 tailnet IP 段，绝不以系统 TCP/DNS 重试。
这是上游不稳定 API；升级 Tailscale 时必须复验初始化、取消、状态、DNS 和只走 netstack。

遥测通过 `envknob.SetNoLogsNoSupport()` 和 `logtail.Disable()` 关闭；后者也阻止 tsnet
自行创建的 Logger 缓冲/上传记录。节点日志不转发给 JS。
创建后端前设置 `TS_LOGS_DIR` 为节点目录下实际存在的私有 logs 目录；Android 进程没有 HOME，
即使关了上报，底层 sockstat 初始化仍需要这个路径。不要设置或改变进程 HOME。
完整状态持久化成功后才更新内存副本；密钥丢失或密文损坏要求用户清除状态，不静默生成新身份。

构建时运行 `node mobile/licenses.mjs <资源目录>/go-third-party.txt`，把生成的第三方完整
许可随原生应用分发。Android 已接入 assets；iOS 桥的资源配置也须包含此文件。
脚本会自行下载 `go.mod` 锁定的 `golang.org/x/mobile` 绑定运行时，再收集两平台的依赖许可，
空模块缓存也可独立执行，不要求 Android 或 iOS 的 gomobile 编译先运行。

`go test -race ./...` 使用临时目录、本地控制面与 DERP 验证真实 netstack、SSH 私钥和
主机指纹校验及停止取消；不使用账户。真实控制服务器登录、平台网络切换仍需单独验收。
