# Computer Use 嵌入库

包名为 `@litch/computer-use`，首版使用独立的 `0.x` semver，不再跟随 Litch。Node 24+，无 Electron 运行时依赖。独立仓只提供 TS 执行器、macOS Swift/Windows Rust 原生助手源码和构建脚本；原生助手由使用方构建、签名、公证（如适用）、打包并嵌入自己的应用，不发布预编译资产。

- 默认入口：`createComputerUse` / `createComputerExecutor`，使用 automation-contracts 的 `ToolInvocation`、`InvocationContext`、`ToolResult`。宿主提供 `HelperAccess` 与 `disposeHelper`，不会自动查找任何产品路径。
- `/tools`：`computerTools`，来自 automation-contracts 唯一源，支持 macOS、Windows、portable 与批量能力开关；产品名、助手名和命名空间显式提供。
- `/node`：帧连接、Mac/Windows 启动器、看护者、`createNodeComputerUse`。Mac 身份、环境键、运行目录和路径由宿主给定；Windows 指定助手路径和产品名。
- `/wire`：原生帧及平台结果类型。

`hostId` 固定在 runtime 上，调用来源只能由可信宿主填写；来自其他 host 的调用被拒绝。自身访问先由助手检查真实进程，再由宿主审批，答复会校验请求号、随机数和完整 scope。缺失/取消/过期/错绑定的答复不会授权。24 小时授权使用可选的 `state: StateStore`，按 hostId 隔离键，CAS 写成功后才执行输入；不给存储时仅留在该 runtime 内存中。`await runtime.selfGuard.revoke()` 可撤销授权。

每回合结束调用 `executor.endTurn(scope)`；会话销毁调用 `endSession`；应用退出先 `dispose()`，等待完成后再终止宿主。调用中止使用 AbortSignal。预览通知只走本机 `onAutomation`，不要写进聊天历史。

构建：在仓库安装精确锁定的依赖后，`npm run build --prefix packages/computer-use`。当前独立编译把实际引用的 contracts 唯一源一并投影到 `dist/automation-contracts`；发布白名单只带 `dist`，不需要仓库源码或路径别名，也不手工维护第二份合同。

宿主入口负责路径定位、手机验签、审批文件和设置 UI；实际执行器、批量、帧、启动器与看护来自本包。

## 最小宿主接线

```ts
import { createNodeComputerUse, MacLauncher } from '@litch/computer-use/node'

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

macOS：独立代码库提供 `apps/computer-use/build.mjs` 的 `buildNative({arch, debug})`，只编译 Swift 并返回可执行文件路径。使用方自己生成 `.app` 的 Info.plist、写入 `ComputerUseHostIdentity`、选择图标、签名、公证和打包。Litch 自己的 `build-app.mjs`/`host-identity.mjs` 是产品组装代码，留在 Litch，不随独立代码库导出。原生源码和构建脚本从对应源码 Release 获取，npm 包只带 TS 运行时。

正式宿主必须与 helper 同团队签名，且 identifier 在构建白名单中；开发 ad-hoc token 示例不证明正式签名集成通过。其他宿主使用自己的 bundle ID、peer/team 和系统授权。

Windows：在 `apps/computer-use-win` 用锁定工具链构建 `x86_64-pc-windows-msvc`。构建必须显式提供 `CU_HELPER_VERSION`、`CU_HOST_PRODUCT`、`CU_HOST_REGISTRY_KEY`、`CU_HOST_EXECUTABLE`、`CU_HOST_ISOLATION_KEYS`；见 [原生协议](NATIVE-PROTOCOL.md)，宿主自己构建、签名（如适用）、打包并嵌入 exe；运行时只接受 stdio，mutex 保持跨宿主共享。macOS 两个独立 helper 没有全局输入仲裁，不能同时输入。

## 验收与限制

- `npm run typecheck --prefix packages/computer-use`；`npm test --prefix packages/computer-use` 包含独立消费者和公共合同/审批/lifecycle/帧测试。
- 使用方的桌面端验收应运行实际共享实现；Swift/Rust 与 TypeScript 宿主同读黄金帧。
- 使用方提供的原生集成夹具 只启动自己构建的第二宿主 helper，不请求系统授权、不输入用户应用；在隔离 HOME 下运行。
- 取消经 `cancelAction`（按 `actionId`）转给原生助手；已经发出的输入不会撤回。
- 正式签名/TCC、Windows 真机、其他宿主安装包接线不由这些假宿主/隐藏窗口测试证明。

### 紧凑状态

get_app_state 新增可选 `detail:"compact"|"full"` 和 `offset`。默认将已去除空装饰容器的状态限制为 180 行、约 10K 字符；`full:true` 仍表示取消 diff，不取消紧凑限制。`detail:"full"` 返回原生助手已有上限内的全文；用 `next_offset` 分页读取当前可用树。原生采集上限之外仍需滚动、选择对应窗口再观察，不宣称可以读取未采集的节点。
截断后强制下一次取完整基准，避免把从未展示的变化当作已知。run_actions 的最终状态共用压缩；保留截图和原生编号，坐标仍有对应图像，不改变输入和权限语义。失败附带 recovery JSON；未知输入失败仍标记可能已执行，不能据此重放整批。
