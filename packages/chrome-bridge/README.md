# 可嵌入 Chrome 桥

Node 本机桥、受控 Chrome 执行器、内置/Chrome 分流和 Native Messaging 登记适配器。无 Electron/core/UI 依赖；导入不监听、不登记、不读取个人 HOME。底层页面操作和站点策略复用 browser，线上 wire 唯一源为 automation-contracts。支持 macOS/Linux Unix socket 与 Windows named pipe；平台登记位置由宿主显式选择。

包名 `chrome-bridge-internal` 暂不代表公开 npm 名称。版本跟 Litch，先构建并 `npm pack`，使用精确 tarball，例如 `npm install --save-exact ./chrome-bridge-internal-0.34.1.tgz`。包内 dist 自包含所需的源码投影，不引用仓库绝对路径。没有 postinstall。

```ts
import {
  ChromeInstaller, ChromeBridge, FileRegistrationStore, createChromeExecutor,
} from 'chrome-bridge-internal'

const installer = new ChromeInstaller({
  root: installationDirectory, assets: extensionAssets, nativeBinary,
  nativeArgs: [], // 独立 chromebridge.Run 入口；CHA 使用 ['chrome-host']
  socketPath,
  identity: { hostName: 'example.automation', extensionIds, productName: 'Example' },
  registrations: [new FileRegistrationStore(manifestDirectory, 'Example Chrome bridge')],
})
await installer.prepare() // 仅由宿主在用户请求安装/已安装后重连时显式调用
const bridge = new ChromeBridge({ socketPath, token: installer.token, extensionIds,
  version: '0.34.1', productName: 'Example', protocol: { min: 1, max: 1 } })
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

`ChromeExecutor` 是 browser 工具端口的底层入口，保留 `call/turnEnded/dispose`，用于现有宿主接线。`createChromeExecutor` 是 contracts `ToolExecutor` 的 scope 入口。`chromeToolsSpec` 提供同源 schema 和 Chrome 说明。上传只接受执行电脑本地文件；宿主应在给 execute 的参数前落实其文件访问策略。没有远程文件复制，也不推导敏感网页操作已被允许。

`createBrowserDispatcher({ namespace, builtin, chrome })` 只按显式 Chrome target/tab 路由；不会因内置浏览器拒绝而换浏览器重试。Litch 的开关、设备准入、设置、UI 和自动准备留在 desktop 的 browser-targets/installer 组装层。

登记使用 contracts `RegistrationStore/RegistrationPolicy`。默认 `sameOwnerPolicy` 只更新同一路径启动器的登记，遇到别的归属拒绝。`FileRegistrationStore` 以启动器绝对路径作为 ownerId，以原文件哈希作为 revision，写入和卸载均做锁及 revision 核对；不会读取隐含系统目录。锁只协调同库写入者，不能保证不遵守锁的其他安装器不会竞态。注册表或集中安装需宿主注入相应存储端口。Windows 的 Litch 外壳保留原 HKCU 登记；隔离验收传 manifestDirectories 时不触碰注册表。

不同应用必须使用独立的 host 名、扩展 ID、安装根目录、socket 和 token。独立 host 不代表可以共享一个标签的 debugger；Chrome 拒绝冲突 attach 时不抢占现有连接。没有共享 broker。nativeBinary 使用 `chromebridge` Go 库编译自己的小入口，不必携带完整 CHA。没有自动下载安装器或签名副作用。

测试：`npm run test --prefix packages/chrome-bridge`，`go test ./chromebridge`，`npm run client:build` 后 `npm run client:check:chrome`。所有 HOME/profile/登记均隔离。公开 npm、正式商店扩展、Windows 注册表与第三方宿主签名包须另验。MIT 及原版权归属见 LICENSE。
