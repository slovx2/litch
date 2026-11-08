# Computer Use 嵌入库

`computer-use-internal` 是暂定的内部构建名，版本跟随 Litch；先交 tarball，不代表已公开发布 npm。Node 24+，无 Electron 运行时依赖。原生助手由使用方构建、签名和嵌入自己的应用。

- 默认入口：`createComputerUse` / `createComputerExecutor`，使用 automation-contracts 的 `ToolInvocation`、`InvocationContext`、`ToolResult`。宿主提供 `HelperAccess` 与 `disposeHelper`，不会自动查找任何产品路径。
- `/tools`：`computerTools`，来自 automation-contracts 唯一源，支持 macOS、Windows、portable 与批量能力开关；产品名、助手名和命名空间显式提供。
- `/node`：帧连接、Mac/Windows 启动器、看护者、`createNodeComputerUse`。Mac 身份、环境键、运行目录和路径由宿主给定；Windows 指定助手路径和产品名。
- `/wire`：原生帧及平台结果类型。

`hostId` 固定在 runtime 上，调用来源只能由可信宿主填写；来自其他 host 的调用被拒绝。自身访问先由助手检查真实进程，再由宿主审批，答复会校验请求号、随机数和完整 scope。缺失/取消/过期/错绑定的答复不会授权。24 小时授权使用可选的 `state: StateStore`，按 hostId 隔离键，CAS 写成功后才执行输入；不给存储时仅留在该 runtime 内存中。`await runtime.selfGuard.revoke()` 可撤销授权。

每回合结束调用 `executor.endTurn(scope)`；会话销毁调用 `endSession`；应用退出先 `dispose()`，等待完成后再终止宿主。调用中止使用 AbortSignal。预览通知只走本机 `onAutomation`，不要写进聊天历史。

构建：在仓库安装精确锁定的依赖后，`npm run build --prefix packages/computer-use`。当前独立编译把实际引用的 contracts 唯一源一并投影到 `dist/automation-contracts`；发布白名单只带 `dist`，不需要仓库源码或路径别名，也不手工维护第二份合同。

Litch 的入口在 `apps/desktop/src/computer-use`：路径定位、手机验签、审批文件和设置 UI 留在宿主；实际执行器、批量、帧、启动器与看护来自本包。

## 最小宿主接线

```ts
import { createNodeComputerUse, MacLauncher } from 'computer-use-internal/node'

const runtime = createNodeComputerUse({
  hostId: 'my-desktop-instance', namespace: 'my_computer',
  productName: 'My Host', helperName: 'My Computer Use',
  platform: 'darwin', batch: true, lang: 'zh-CN',
  launcher: new MacLauncher({
    appPath: '/Applications/My Host.app/Contents/SharedSupport/My Computer Use.app',
    directory: '/a/short/host-owned/run-directory', version: hostVersion,
    identity: {
      helperId: 'ai.example.my-host.computer-use', helperName: 'My Computer Use',
      executableName: 'MyComputerUse', directoryEnv: 'MY_CU_DIR', tokenEnv: 'MY_CU_TOKEN',
    },
  }),
  onAutomation(notice) { /* 交给本机预览；不发给模型 */ },
})
// runtime.executor.definitions 提供 schema、说明和 instructions。
// runtime.executor.execute(call, { signal, approvals, hold })：来源由宿主填写。
// approvals.request 必须通过可信 UI/验签通道取得答案并返回原请求绑定字段。
// 不支持审批时返回 null，不要自动允许。
// 应用退出：await runtime.dispose()
```

上面的路径和身份是示意值，实际资源路径由打包器传入。HelperAccess 可以是宿主自己实现的 Rust/Swift 请求桥，非 Electron 宿主不需要加载 Electron；使用 TS 执行器仍需要 JavaScript 运行时。不要把后端请求接口放进页面的 preload。

## 自己构建原生组件

macOS：调用 `apps/computer-use/build-app.mjs` 导出的 `buildHelper`，提供完整 `hostIdentity`、`appName`、`executableName`、`iconPath`（null 表示不带图标）、`version`、`out`、`arch`；也可通过 `--config <JSON>` 传这些字段。再 `signHelper(app, {identity, keychain})`，签名 ID 从所构建的 Info.plist 读取。第三方应随 SDK 获取 `apps/computer-use` 的原生源码组件及构建器，自己构建、签名和公证；不复用 Litch 的签名助手。Litch 默认值在 `host-identity.mjs`，默认 bundle ID、名称和已有授权归属均不变。

完整配置示例和启动验证在 `test/native-host.mjs`，其第二身份不包含 Litch peer ID。正式宿主必须与 helper 同团队签名，且 identifier 在构建白名单中；开发 ad-hoc token 示例不证明正式签名集成通过。SDK tarball 只含 TS 运行时，原生源码和构建器需另外获取（见上一段）。

Windows：在 `apps/computer-use-win` 用锁定工具链构建 `x86_64-pc-windows-msvc`。构建变量见 [原生协议](NATIVE-PROTOCOL.md)，宿主自己嵌入 exe；运行时只接受 stdio，mutex 保持跨宿主共享。macOS 两个独立 helper 没有全局输入仲裁，不能同时输入。

## 验收与限制

- `npm run typecheck --prefix packages/computer-use`；`npm test --prefix packages/computer-use` 包含独立消费者和公共合同/审批/lifecycle/帧测试。
- 原有 `apps/desktop` 的 `test:computer-use` 仍运行实际共享实现，旧入口不是另一份代码；Swift/Rust 同读黄金帧。
- `test/native-host.mjs` 只启动自己构建的第二宿主 helper，不请求系统授权、不输入用户应用；在隔离 HOME 下运行。
- 取消经 `cancelAction`（按 `actionId`）转给原生助手；已经发出的输入不会撤回。
- 正式签名/TCC、Windows 真机、WakeQora 安装包接线不由这些假宿主/隐藏窗口测试证明。
