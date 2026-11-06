# 自动化公共合同

本模块处于接口冻结阶段：提供工具定义、宿主端口、Litch 自包含协议投影和独立消费者检查。**尚未提供真实浏览器、Chrome 或 Computer Use 执行器**；它们由后续能力模块实现。

目录名与 `automation-contracts-internal` 是仓内构建标识，不代表已确定的公开包名。当前为 private，零运行时依赖；先验证 tarball，公开 npm 发布须另行批准。版本沿用仓库根版本，源码是 `.mts`，构建为 ESM `.mjs` 与 `.d.mts`。MIT，归属见 [LICENSE](LICENSE)。

## 两种入口

- 默认入口：语义 `BrowserDriver`、审批/调用生命周期、状态/秘密/日志/文件/URL 端口、原生组件端口、Chrome 身份及登记策略、预览几何类型。
- `/litch`：Litch 实例的既有工具 schema、英文说明、instructions、Chrome wire/身份配置。只供需要现有 Litch 行为的使用方显式选择；默认入口没有 Litch 扩展 ID、native host 名或模型命名空间。

库导入不创建窗口、连接 helper、登记 native host 或读取 HOME。文件路径、身份、存储、审批及生命周期全部由可信宿主传入。

## 构建和验证

在仓库根安装已有锁定依赖后运行：

```sh
npm run build --prefix packages/automation-contracts
npm run check:automation-contracts
```

第二条会检查依赖闭包、生成投影、schema 基线，构建 tarball 后在仓库外隔离目录离线安装，用独立 TypeScript 消费者编译并运行 [Node fake host](examples/fake-host.mts)。该示例没有真实网页、系统权限或凭据；批准/拒绝/取消由模拟可信宿主提供，不是自动批准的生产入口。

消费者无需继承本仓库的 tsconfig 或路径别名。测试从 manifest 读取包名，消费默认入口和 `/litch` 子入口；改公开包名不用改合同。SDK 使用 Node/DOM 标准类型如 AbortSignal；平台实现必须在自己的后端处理系统能力。

## 唯一源与投影

工具定义的唯一源为 `src/litch/client-tools-*.mts`，Chrome 现有 wire/实例配置为 `src/litch/chrome-browser.mts`，几何源为 `src/automation-surface.mts`。`scripts/generate-automation-contracts.mjs` 将它们投影到 protocol 同名文件及 `automation-tool-spec.mts`。设备包只看到 protocol 内部文件，不引本包、core 或 Node/Electron。

```sh
npm run generate:automation-contracts
```

只修改源，不手改生成文件。`npm run check` 包含投影漂移、依赖闭包及独立消费者检查。基线哈希固定抽取前的 schema/说明/指令序列化值；后续确需改工具行为时，必须说明原因并同时更新行为测试，不能为了让抽取通过随便重录基线。

## 接口约束

| 合同 | 使用方责任 |
|---|---|
| `ToolExecutor` | 明确 execute/endTurn/endSession/dispose，正确发出取消、撤租约和释放资源；绝不自动重放可能执行过的输入 |
| `InvocationScope` | host/device/session/turn/call 由认证后的宿主填写，不能来自模型参数；不同租户的 ID 不得串用 |
| `ApprovalPort` | 可信 UI 或验签后答复；hold 配对恢复；返回 id/nonce/完整 scope；`approvalDecision` 仅检查绑定/过期/取消，不替代用户身份认证或防重放账本 |
| `BrowserDriver` | 语义接口，无 CDP/Electron 对象；来源门禁、文档/几何版本、冻结覆盖所有观察路径；不支持的能力明确 false/失败 |
| `SignInPort` | 自己验证页面/框架，冻结和清理，密码只经过可信后端；不把网页脚本回报当成批准或可靠清理证明 |
| `StateStore` | 原子版本读写；CAS 失败不得覆盖；秘密另走 SecretStore，不存普通日志/事件 |
| `NativeLauncher` | 原生 helper 路径/版本/签名身份明确；Mac 保留 LaunchServices 和独立 TCC，Windows 保证管道/父退出收尾 |
| `ChromeHostIdentity` | 每个使用方配置自己的 host 名/允许扩展 ID；不能自动信任 Litch 的 ID |
| `RegistrationPolicy/Store` | 宿主选择登记策略，写入时复核 revision，卸载只移除自己仍拥有的登记；M2 不替使用方决定接管/覆盖/共享 |
| `ExtensionRuntime` | 显式 start/stop；只撤自己登记的监听器/租约；M3 扩展库再实现 Chrome API adapter |

这些是可信后端接口，不能整组透传到 preload 或网页。scope/身份配置、`NativeHelperPort.request`、批准答复和密钥端口都不属于 AI 工具参数 schema。正式能力包必须验证工具参数并封装内部调用。

## 后续模块归属

| 线 | 独占范围 | 共用约定 |
|---|---|---|
| CU | computer-use 包、Swift/Rust 核心/组件和原 desktop CU 目录/测试 | 采用 NativeLauncher/HelperPort、权限/审批合同；不先移动未跟进主线修复的原生代码 |
| browser | browser 包、原 browser/browser-import、相关测试与说明 | 采用 BrowserDriver/SignInPort/Presentation，CDP 是一种实现；Electron 必须由宿主注入 |
| Chrome | chrome-bridge/chrome-extension 包、Go 转发库/组装入口、原 chrome-browser、扩展实例/E2E | 采用 ChromeHostIdentity/RegistrationPolicy；独立扩展 ID 不保证同 tab debugger 并发 |
| 集成 | 本 contracts 包及生成器、protocol、core/UI/main/preload、CI/构建/资源和首页 | 三线提出合同变更，由集成统一修改，避免多份定义 |

当前没有声明 Electron 44.7.0/44.10.2、正式签名 helper 或实际第三方扩展已通过验收；这一阶段只验证独立合同与现 Litch 投影行为。
