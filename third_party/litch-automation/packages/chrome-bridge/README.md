# 可嵌入 Chrome 桥

Node 本机桥、受控 Chrome 执行器、内置/Chrome 分流和 Native Messaging 登记适配器。无 Electron/core/UI 依赖；导入不监听、不登记、不读取个人 HOME。底层页面操作和站点策略复用 browser，线上 wire 唯一源为 automation-contracts。支持 macOS/Linux Unix socket 与 Windows named pipe；平台登记位置由宿主显式选择。

包名为 `@litch/chrome-bridge`，首版使用独立的 `0.x` semver，不再跟随 Litch。包内 dist 自包含所需的源码投影，不引用仓库绝对路径；npm 包没有 postinstall。Native Messaging host、登记目录、扩展 ID 和签名/打包由使用方配置和负责。

```ts
import {
  ChromeInstaller, ChromeBridge, FileRegistrationStore, createChromeExecutor, chromeClaimDirectory,
} from '@litch/chrome-bridge'

const installer = new ChromeInstaller({
  root: installationDirectory, assets: extensionAssets, nativeBinary,
  nativeArgs: [], // 独立 chromebridge.Run 入口；CHA 使用 ['chrome-host']
  socketPath, claimLockDirectory: chromeClaimDirectory(home, platform, localAppData),
  identity: { hostName: 'example.automation', extensionIds, productName: 'Example' },
  registrations: [new FileRegistrationStore(manifestDirectory, 'Example Chrome bridge')],
})
await installer.prepare() // 仅由宿主在用户请求安装/已安装后重连时显式调用
const bridge = new ChromeBridge({ socketPath, token: installer.token, extensionIds,
  version: hostVersion, productName: 'Example', protocol: { min: 1, max: 1 } })
await bridge.start()
const executor = createChromeExecutor({ bridge, hostId: 'example', namespace: 'example_browser',
  productName: 'Example', allowed: scope => trustedSessions.has(scope.sessionId) })
// definitions 可交给模型 SDK；execute(call, context) 的 scope 由可信宿主填入。
const result = await executor.execute(call, { signal, approvals, hold })
await executor.endTurn(scope)
await executor.dispose()
await bridge.close()
```

`approvals` 使用 contracts 的 ApprovalPort：宿主先验证 UI/签名，运行时再核对 requestId、nonce、完整 scope 和取消；模型不能提供答复。hold 暂停宿主等待计时。`endTurn/endSession/dispose` 取消等待、撤销审批、释放租约；可能已经发送的输入不自动重放。Chrome 登录仅交给用户手工完成，整个实例冻结观察/输入，完成后必须重新认领。

`ChromeExecutor` 是 browser 工具端口的底层入口，保留 `call/turnEnded/dispose`，用于现有宿主接线。`createChromeExecutor` 是 contracts `ToolExecutor` 的 scope 入口。`chromeToolsSpec` 提供同源 schema 和 Chrome 说明。上传只接受执行电脑本地文件；SDK 入口没有 files: FileAccess 时不声明/开放 upload，有端口时先调用 authorizeUpload。没有远程文件复制，也不推导敏感网页操作已被允许。

`createBrowserDispatcher({ namespace, builtin, chrome })` 只按显式 Chrome target/tab 路由；不会因内置浏览器拒绝而换浏览器重试。Litch 的开关、设备准入、设置、UI 和自动准备留在 desktop 的 browser-targets/installer 组装层。

登记使用 contracts `RegistrationStore/RegistrationPolicy`。默认 `sameOwnerPolicy` 只更新同一路径启动器的登记，遇到别的归属拒绝。`FileRegistrationStore` 以启动器绝对路径作为 ownerId，以原文件哈希作为 revision，写入和卸载均做锁及 revision 核对；不会读取隐含系统目录。锁只协调同库写入者，不能保证不遵守锁的其他安装器不会竞态。注册表或集中安装需宿主注入相应存储端口。Windows 的 Litch 外壳保留原 HKCU 登记；隔离验收传 manifestDirectories 时不触碰注册表。

不同应用必须使用独立的 host 名、扩展 ID、安装根目录、socket 和 token。独立 host 不代表可以共享一个标签的 debugger；库先用 getTargets 拒绝已附着的目标，attach 后只核对目标仍存在并附着；后置布尔状态不能分辨其他调试器。没有共享 broker。nativeBinary 使用 `chromebridge` Go 库编译自己的小入口，不必携带完整 CHA。没有自动下载安装器或签名副作用。

测试：`npm run test --prefix packages/chrome-bridge`，`go test ./chromebridge`，`npm run client:build` 后 `npm run client:check:chrome`。所有 HOME/profile/登记均隔离。公开 npm、正式商店扩展、Windows 注册表与第三方宿主签名包须另验。MIT 及原版权归属见 LICENSE。

**跨应用互斥有明确前提：双方均使用新组件，并配置同一个 claimLockDirectory。** Go host 转发已有 claim 前，以真实 CDP targetId 的哈希文件做 flock / LockFileEx；扩展完成 detach 后的 revoked、claim 失败及进程退出释放内核锁。Node 不阻塞等待锁，也不重试输入；竞争者返回 busy。只用 getTargets 的旧方案曾在定向 5 轮中 4 轮双方成功，不能作为原子互斥。旧扩展不带新 metadata 时保留 wire 1 原行为，因此不能承诺与旧组件或不合作调试器之间的原子互斥。没有其他控制者时单 Litch 的允许/拒绝和租约语义保持，新增锁有少量系统调用耗时，实际基准见扩展包 COMPATIBILITY.md。

共享目录由宿主**显式传入**，库不读取个人 HOME；Litch 和 WakeQora 应传同一个每用户约定路径（`chromeClaimDirectory` 为纯路径函数）：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/chrome-automation-claims/v1` |
| Windows | `%LOCALAPPDATA%/chrome-automation-claims/v1`（未提供 LOCALAPPDATA 时为用户目录下的 `AppData/Local/...`） |
| Linux | `~/.local/state/chrome-automation-claims/v1` |

测试一律传共同的临时目录。空锁文件保留，不在释放时 unlink，否则可被新 inode 绕过正在持有的锁；锁状态属于内核，空文件不表示还在占用。不同 Chrome 实例/profile 的 targetId 是不同的随机目标标识；同一目标在两个扩展中相同。不得把扩展各自的 instanceId、host 名加入锁键，否则彼此不再互斥。新扩展附带真实目标元数据，Node 仅从可信列举结果组成 claim；原有 wire 1 的操作/消息类型不变。扩展 attach 前核对当前 targetId，变化时失败重列。用自己的扩展组装时勿移除该核对。

### 一次准备 Chrome 标签

`ensure_claimed({targetId,url?})` 只选精确 URL，省略 url 时选最后焦点窗口的当前标签；多匹配直接要求明确选择。`ensure_claimed({tabId})` 恢复本会话原标签，一次完成列表、来源检查、认领、加载等待和新快照，返回稳定 tabId 与新 ref。未引入扩展 RPC，沿用 v1 list/claim/renew/command。
同一实例的过期租约最多自动恢复一次；断线失效的只读 snapshot 可自动恢复，显式 release 后须明确 ensure_claimed。未知实例、用户停止、登录暂停、站点拒绝和其他会话占用都不猜测替代目标，不自动重放输入。callId 去重规则仍适用。
重认领核对原 DevTools target，防止 Chrome 重启重用数字 tabId 后误接管其他标签；缺少可核对身份时要求明确重新选择。用户停止、显式释放或无法判定原因的调试器撤销不会触发隐式恢复。
失败 JSON 新增 recovery，给明确下一步与保守的执行状态；输入失败以 inputReceipt.recovery 的实际派发记录为准。工具说明优先 ensure_claimed 与 run_actions，批末显式等待业务确认。
