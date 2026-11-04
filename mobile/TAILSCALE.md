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
登录 URL 可能稍后出现，前台设置页查询并提供系统浏览器入口。只返回 HTTPS 登录 URL。
错误带 `[tailscaleLogin]` 等种类，UI 映射中英文；不要向界面输出原生秘密或网络调试日志。

`Target` JSON 的可选 `tailscale:boolean` 决定网络；`ProbeHost(host,port,user,tailscale)`
也必须传同一个选择。其余 SSH 导出方法签名不变。脚本、长流、登记、升级都经过 `connectSSH`。

## Android 网络与存储

在首次创建节点前调用 `SetTailscaleInterfaces(encoded string) error`，之后网络切换再调用：

```json
[{"index":1,"name":"eth0","mtu":1500,"up":true,"loopback":false,"pointToPoint":false,"multicast":true,"addresses":["192.0.2.2/24"]}]
```

数据必须由 Android 公开平台 API 获取。Go 注册 `netmon.RegisterInterfaceGetter` 并触发网络
重新采样，避开 Android 普通应用无法使用的 netlink。不要传假接口或忽略解析失败。
Android 原生实现用 Keystore AES-256-GCM、每次随机 IV、固定 AAD 和 AtomicFile；密文在
`noBackupFilesDir`，不随设备备份。iOS 用同一个存储接口接 Keychain 与平台文件保护。

`SetAppBackground`、`BackgroundDeadline` 共用原有连接暂停策略。系统允许提前到期；
不以实际经过五分钟为前提。暂停关闭节点和连接，前台的下一次拨号或状态查询恢复。

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

`go test -race ./...` 使用临时目录、本地控制面与 DERP 验证真实 netstack、SSH 私钥和
主机指纹校验及停止取消；不使用账户。真实控制服务器登录、平台网络切换仍需单独验收。
