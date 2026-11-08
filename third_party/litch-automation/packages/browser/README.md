# 可嵌入浏览器

包名为 `@litch/browser`，首版使用独立的 `0.x` semver，不再跟随 Litch。它提供可嵌入的浏览器、AI 工具执行器、来源许可、密码登录与导入组件。默认入口不加载 Electron；Electron 主进程集成使用显式子入口。本包不提供成品浏览器应用，也不会注册扩展或 native host。

Chrome 桥复用的低层模块：

- `src/browser/model.mts`：CDP 页面/标签宿主。ChromePage 可以实现它，不引用 Electron；低层 CDP 不进入模型参数。
- `src/browser/sites.mts`：`createSiteBook(file | SitePersistence | null)`，独立 browser/Chrome 授权实例；文件路径由宿主传入，不改变 once/session/always 和拒绝规则。
- `src/ports.mts`：`CdpDriverFactory` 返回 `BrowserDriverRuntime`，输入 `hostId/host/sites` 及可选的可信冻结、变更、存储落盘钩子；语义接口沿公共合同，CDP 仅为实现。
- `src/tool-port.mts`：当前工具适配器的调用/答复/审批端口，结构保持 Litch 接线，包不依赖 Litch core/protocol。第三方可以使用语义 driver，不需要使用 Litch 工具传输形状。
- `src/browser/cdp-allow.mts`、`ax.mts`、`args.mts`、`keys.mts`：现有白名单与页面工具基础，归本包维护，不在扩展线复制。

宿主可以提供同名转发入口；实现只有本包一份，没有旧数据回退或双实现。

## 入口与分层

| 入口 | 内容 | 宿主负责 |
| --- | --- | --- |
| `.` | `createCdpDriver`、语义合同、`createBrowserExecutor`、`browserToolsSpec`、站点策略、CDP 白名单 | 页面后端、会话身份、审批、生命周期 |
| `/electron` | `createElectronHost`、Cookie 持久化、登录交接、自动填充和保存提示 | Electron 进程、分区、窗口、可信 UI、preload 位置 |
| `/import` | 导入管线、读取器、密码库、加密器端口和导入状态 | 资料根路径、用户授权、密钥来源、日志和存储路径 |
| `/preload` | 网页隔离环境的密码填充、清框和保存捕获 | 构建成沙箱可加载的 CommonJS preload，不能直接当 ESM 预加载 |
| `/native/build` | macOS 钥匙串 Node-API 组件构建函数 | Node 头文件、输出目录、可执行文件身份、签名与打包 |
| `/batch`、`/executor`、`/tools`、`/url` | `runBrowserActions`、`Call/TabState`、`TOOLS` 和 URL 工具，供 Chrome bridge 复用 | 本机执行器装配、页面/租约/审批检查 |
| `/pointer-renderer`、`/surface` | 纯 DOM 代理光标和坐标合同，无 Node/Electron/React 依赖 | surface 身份、布局版本、颜色与动作样本 |

低层 `/model`、`/sites`、`/ax`、`/args`、`/keys`、`/cdp-allow` 也作为显式入口提供。扩展 isolated world 应只导入 `/pointer-renderer`（或 `/surface`）；默认入口包含 Node 工具组件，不能作为浏览器 bundle 的入口。光标的到位回执只报告呈现结果，不授予输入权限。Litch 界面的自动化预览同样使用 `/pointer-renderer`。

`BrowserDriver` 是语义接口，包含页生命周期、观察、输入、导航、冻结和存储落盘。`createCdpDriver` 将 `CdpHost` 转成此接口：观察携带文档与布局版本；输入前复核身份、来源、冻结状态和版本。取消后不重放输入，已发出的动作可能已经发生。需要截图/输入的宿主必须提供真实能力，不能用 `evaluate` 冒充可信输入。

`createBrowserExecutor` 提供现有完整工具 profile：快照、截图、输入、导航、批量、上传及 `request_sign_in`。其 `ClientToolInvocation` / `ClientToolContext` 是无 core/protocol 依赖的宿主端口；`context.ask` 承载来源审批，`hold/show` 承载登录交接，`signal` 承载取消。工具 schema 与说明来自 automation-contracts 唯一源，Litch 的名称、说明和答复保持原样。第三方可以直接注册这份 profile，并把自己的调用/答复转换为该端口。可选 stdio MCP 封装归后续入口工作。

同一 `CdpHost` 由语义 driver 或工具 executor 其中一个接管导航闸；不要把两者同时装在同一 host 上。两者复用页面操作实现，但不是可以叠加的拦截器。非 CDP 宿主自行实现语义 `BrowserDriver`，不能直接使用 CDP 工具 executor。WKWebView/Tauri 的可信输入、跨域 frame 和隔离登录等能力仍需该宿主实现并验收。

## Electron 宿主接入

以下 `@litch/browser` 指本地 tarball 的内部包名。示例在宿主主进程执行，变量 `stateDir`、`preloadPath`、`failurePage` 由应用提供：

```ts
import { createSiteBook, createBrowserExecutor } from '@litch/browser'
import { createElectronHost, restoreBrowserCookies } from '@litch/browser/electron'
import { join } from 'node:path'

const partition = 'persist:your-product-browser'
// 必须在第一个标签导航前恢复；退出/更新之前等待 cookies.flush()。
const cookies = await restoreBrowserCookies({
  partition, file: join(stateDir, 'session-cookies.enc'),
  warn: () => logger.warn('浏览器登录状态暂时无法保存'),
})
const host = createElectronHost({
  partition, autofillPreload: preloadPath, failurePage,
  blockedDownload: name => `Downloads are not supported: ${name}`,
  // downloads: { stagingRoot, downloadsDirectory }：开启受控下载，不给就一律拦下
  // navigation: { rewrite: (page, url) => resolver.rewrite(page, url) },
})
const executor = createBrowserExecutor({
  host, sites: createSiteBook(join(stateDir, 'sites.json')),
  // handover: 下面组装的可信登录交接端口
  // resolveUrl / describeUrl: 会话级远端地址转发及说明
})
// host.place(window, tabId, rect)：把 WebContentsView 放到自己的窗口。
// host.onChange / host.onShow：向自己的 UI 发状态，显示动作由宿主处理。
// executor.call(invocation, context)：来源审批只由可信 UI 回答。
// 回合完成、取消、断线都调用 executor.turnEnded(...)。
// 清数据：await cookies.clear(() => host.clearData())。
// 退出：await cookies.flush(); cookies.dispose(); host.dispose()。
```

`partition` 必须专供本组件；该 session 会拒绝页面权限与屏幕共享，没开 `downloads` 时也拒绝下载，并清空 session 级 preloads。开了 `downloads` 时，下载先收进 `stagingRoot` 下的私有目录，`context.ask` 收到 `browserDownload` 审批，批准后才发布到 `downloadsDirectory`；接通用 `ApprovalPort` 的宿主用 `browserApprovalSubject` 转成 `{ kind: 'download' }`。退出前调用 `host.downloads?.dispose()` 清掉暂存区。不要传应用主界面的 session。这里复用 Chromium CDP 与 Electron session；不会把旧应用的 Cookie/密码目录迁移到新应用。Cookie 快照保留 session Cookie 和 CHIPS 键，使用私有控制页访问 Network，模型工具仍不能读取 Network/Storage。

默认 Cookie 加密使用 Electron `safeStorage`，不可用时不保存明文。测试或有自己的密钥库的宿主可注入 `cipher`。日志钩子只通知保存失败，不携带 Cookie。站点策略可以传文件或 `SitePersistence`；不同产品必须使用不同实例和目录，禁止通过共用文件继承其他宿主的授权。

网页 preload 用 esbuild 等构建器将 `/preload` 入口打成 `format: 'cjs'`、`platform: 'node'`，将 `electron` 留作 external；`autofillPreload` 传该绝对路径。应用自己的 preload/IPC 负责面板与审批卡，不把网页 preload 的接口暴露给普通渲染页面。

## 密码、登录与导入

1. `createPasswordStore({ file, cipher })` 建自己的密码库；文件路径与加密器显式传入。密码明文只在可信主进程中短暂使用，不进工具结果。
2. `createSignIns`、`createSavePrompts` 建卡片状态。可信 UI 订阅并回答；账户编号只在当次卡片有效。若接手机，必须由宿主验签与验证设备身份。
3. `createHandover({ host, signIns, ... })` 组装登录预检、观察闸、代填、清框和重载；传给工具 executor 的 `handover`。具体依赖见导出的 `HandoverOptions`。未装 handover 时登录工具返回不支持，不会改用模型填密码。
4. `installAutofill(store, prompts, menuWords?)` 安装网页 IPC 与原生菜单；第三个参数可返回宿主自己的标题和空用户名文案。默认保留 Litch 文案。当前每个 Electron 主进程只安装一次密码服务，并使用一个浏览器标签宿主；不要为不同密码库重复注册同名 IPC。纯页面分区可独立创建与销毁。
5. `createImporter` 完全注入 `env`、reader、CookieJar、密码 sink、状态 book 和日志。`assembleImporter` 是采用 `userData/browser` 状态布局的便捷组装；需要其他布局时使用 `createImportStateBook(file)` 和 `createImporter`。导入只能从用户明确选择的资料读取，包不会在 import 时自动扫描个人目录。

macOS `createProtectedReader` 接受 `platform` 和 `SystemSecrets`。可用 `systemSecrets(runCommand, { executable, directory, run: runCommand })`：`executable` 是宿主签名的 Electron 可执行文件或批准的 Node 可执行文件；`directory` 包含 `keychain.node` 与 `keychain-helper.mjs`。没有 Mac runtime 时返回 unsupported，不猜 Litch 资源路径。Windows 读取器保留原 DPAPI/应用绑定限制；Firefox 解密由本包实现；测试中的外部 NSS 只用于可选交叉核对，不是运行时依赖。

构建 macOS 原生组件：`buildKeychain({ out, nodeHeaders? })`，从 `/native/build` 导入。它使用 Node-API 8、系统 clang 与 Security.framework；tarball 附源码和启动脚本，宿主自己编译、签名、打包（通常放 asar 外）。不要把另一应用的签名当成自己访问钥匙串的授权。Electron/Node 宿主退出前必须取消导入并清理子进程。

其他宿主的新 Electron 客户端可采用以上主进程接线：它自己提供可信 preload、分区、存储路径、审批卡与构建资源。Litch 当前验证 Electron 44.7.0；其他 Electron 版本仍需在宿主应用中复验 CDP、sandbox preload、session Cookie、koffi/打包与签名。本包不接管自动更新，退出前的 flush 等待顺序由宿主安排。

## 构建与验收

源码在 monorepo 中用路径引用；构建使用仓库固定版本 TypeScript/esbuild，Electron 类型依赖位于本包。产物包含唯一 contracts 源编译出的自包含类型/工具定义，不依赖仓内 protocol/core/UI。运行时没有 npm 依赖；Electron 子入口由宿主提供 Electron。

```sh
npm ci --ignore-scripts --prefix packages/browser
npm run build --prefix packages/browser
npm run test --prefix packages/browser
npm run check:package --prefix packages/browser
npm run check:electron --prefix packages/browser
```

`check:package` 检查源码边界和 tarball 依赖闭包，离线装入仓外消费者，并编译运行 [Node fake host](examples/node-host.mts)。`check:electron` 使用本包固定版本的 Electron，测试独立 partition、私有 Cookie 文件、默认 session 隔离及语义 driver；全隐藏且使用模拟钥匙串。Litch 原有浏览器/导入测试继续经接线外观验证唯一实现，跨进程持久化与真实面板检查由桌面端脚本执行。

本包遵循 [MIT 许可证](LICENSE)。tarball 由宿主按自身发布流程集成；没有自动公开发布步骤。

### 紧凑观察与恢复

snapshot 默认最多 180 行、约 10K 字符，仍略去装饰容器与重复文字。`detail:"full"` 提高到 1500 行、约 60K；`offset` 根据 `observation.next_offset` 读取后续行。分页针对完整快照，`diff:true` 在有完整基准时只回变化；截断后不推进基准，避免漏掉从未返回的内容。
ref 含文档代次（如 `e3g12`）；同一文档保留稳定编号，文档更换、重新认领或节点消失后旧 ref 失效。错误给 `recovery.needs_snapshot` 与修复提示；输入的精确恢复字段在 `inputReceipt.recovery`。
已知连续操作优先 run_actions，以 wait(selector/text/url) 结束验证业务条件。结果新增 `verification.status`（matched/notConfirmed/notRequested），只证明所给条件匹配；业务结果仍由调用方判断。最终快照优先紧凑 diff。截图继续显式调用 screenshot。
