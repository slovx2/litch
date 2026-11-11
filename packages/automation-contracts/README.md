# 自动化公共合同

本模块提供工具定义、宿主端口、自包含工具 profile 和独立消费者检查，本身不含执行器。执行器在 [computer-use](../computer-use)、[browser](../browser)、[chrome-extension](../chrome-extension) 与 [chrome-bridge](../chrome-bridge) 包里，都基于这里的合同。

包名为 `@litch/automation-contracts`，首版使用独立的 `0.x` semver，不再跟随 Litch 版本。仓库发布 npm 包和源码 GitHub Release；不包含 Litch 的协议、core、UI 或桌面实现。零运行时依赖，源码是 `.mts`，构建为 ESM `.mjs` 与 `.d.mts`。MIT，归属见 [LICENSE](LICENSE)。

## 两种入口

- 默认入口：语义 `BrowserDriver`、审批/调用生命周期、状态/秘密/日志/文件/URL 端口、原生组件端口、Chrome 身份及登记策略、预览几何类型。
- `/litch`：Litch 实例的既有工具 schema、英文说明、instructions、Chrome wire/身份配置。只供需要现有 Litch 行为的使用方显式选择；默认入口没有 Litch 扩展 ID、native host 名或模型命名空间。

库导入不创建窗口、连接 helper、登记 native host 或读取 HOME。文件路径、身份、存储、审批及生命周期全部由可信宿主传入。

## 构建和验证

在仓库根安装已有锁定依赖后运行：

```sh
npm run build --prefix packages/automation-contracts
npm run check:package --prefix packages/automation-contracts
```

第二条会检查依赖闭包、生成投影、schema 基线，构建 tarball 后在仓库外隔离目录离线安装，用独立 TypeScript 消费者编译并运行 [Node fake host](examples/fake-host.mts)。该示例没有真实网页、系统权限或凭据；批准/拒绝/取消由模拟可信宿主提供，不是自动批准的生产入口。

消费者无需继承本仓库的 tsconfig 或路径别名。测试从 manifest 读取包名，消费默认入口和 `/litch` 子入口；改公开包名不用改合同。SDK 使用 Node/DOM 标准类型如 AbortSignal；平台实现必须在自己的后端处理系统能力。

## 唯一源与投影

工具定义的唯一源为 `src/litch/client-tools-*.mts`，现有 Chrome wire/profile 为 `src/litch/chrome-browser.mts`。Litch 的协议投影生成器及一致性测试由 Litch 自己维护，独立库只验证源码和哈希基线；不依赖产品目录。`/litch` 显式 profile 中的公开扩展 ID 与线上 wire 字段保留兼容语义；通用入口的宿主身份必须显式传入。

`test/litch-schema-baseline.json` 只记各套工具定义（浏览器、三个平台的电脑操作、批量、portable、代填失败码）序列化后的 SHA-256，用来发现模型看到的 schema、说明或指令被无意改动。有意修改工具定义时：

1. 改 `src/litch/` 里的源，在使用方运行其协议投影生成器；
2. 运行 `node --import tsx packages/automation-contracts/test/update-schema-baseline.mts` 重录基线，它会列出变了哪几套；
3. 提交说明写清改了哪个工具的什么，需要时同时更新行为测试。

基线测试失败、而你并没打算改工具定义时，不要重录，先找出是什么改动波及了它。

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
| `RegistrationPolicy/Store` | 宿主选择登记策略，写入时复核 revision，卸载只移除自己仍拥有的登记；合同不替使用方决定接管/覆盖/共享 |
| `ExtensionRuntime` | 显式 start/stop；只撤自己登记的监听器/租约；Chrome API 适配由 chrome-extension 包实现 |

这些是可信后端接口，不能整组透传到 preload 或网页。scope/身份配置、`NativeHelperPort.request`、批准答复和密钥端口都不属于 AI 工具参数 schema。正式能力包必须验证工具参数并封装内部调用。

### 自动化恢复与观察合同

公开导出 `AutomationRecovery`、`automationRecovery` 和 `observationSlice`。错误文字旁的 JSON 带 `recovery`，字段为 `status/retryable/needs_snapshot/needs_claim/needs_approval/may_have_executed/next_action/hint`；浏览器输入以 `inputReceipt.recovery` 为准，因为只有它知道实际派发情况。未知异常保守标记可能执行，不授权重放。
工具 schema 新增 `ensure_claimed`，snapshot 与 get_app_state 新增可选 `detail/offset`；原字段和工具保留。快照元数据给 `generation/mode/truncated/next_offset/total_lines`；ref 为不透明字符串，不能自行解析或拼接编号。
