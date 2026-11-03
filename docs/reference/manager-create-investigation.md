# 新建经理校验排查（issue #8）

## 结论与证据边界

【事实】截图里的子会话设置（Codex、`gpt-6-astra`、`high`、不使用独立工作树、经理合并、并行 4、桌面通知、持续等待）是合法配置。隔离设备夹具中，任务开始时的 main `3642addd`、`v0.29.0`、`v0.28.2`、`v0.28.1`、`v0.28.0` 都能创建并落库；把经理本身也设为 Codex，同样成功。

【事实】原客户端只检查目录非空，设备却要求存在的绝对目录；`~`、`~/project`、普通相对目录、不存在的目录、文件路径、未配置的 harness 都能稳定触发 `invalidManager`。中文错误映射把不同的设备原因覆盖为“经理设置无效，请检查填写的内容”，表单也没有利用字段位置。这是已复现的校验差异与报错缺陷。

另将 `3642addd` 的客户端核心也独立编译，与同一快照设备配对执行：截图配置成功；`cwd=~` 返回客户端 `code=invalid`、`key=cwd`、英文原因为 `cwd must be an absolute directory.`、中文正是“经理设置无效，请检查填写的内容”。因此同版本上的旧提示已经直接复现，不只依据源码推断。

【推测】报告人的实际失败可能来自目录写法或目录失效。反馈截图没有目录、原始 RPC 错误和完整输入，不能确定这一次的唯一根因。经理补充用户的设备服务版本正确；本次版本矩阵也没有证明截图配置存在版本兼容问题。

所有模型和 harness 均为假引擎；设备校验、路由、SQLite 落库及当前客户端核心是真实代码。未操作用户真实设备或经理，也没有验证真实 GPT-6-Astra 的模型服务。

## 创建调用链与旧文案的全部来源

`packages/ui/src/manager/ManagerForm.tsx` 的提交 → 通道 `managers.create` → `packages/core/src/core.mts` → `packages/core/src/device/manager.mts.create` → `litch/manager/create` → 设备 `routes.mts` / `session.mts` → `DeviceManagers.call/create` → `validateCreate` → harness/权限检查 → `thread/start` → `ManagerStore.transaction/saveManager/saveReset/record/enqueue` → 经理通知及开场投递。

旧中文文案只有一个映射点：核心 `device/manager.mts` 的 `failure` 把 `RpcError.data.litch === 'invalidManager'` 映射为通用中文，再由界面 `reasonOf` 显示。其余经理操作也复用这个映射，但新建流程能到达的输入失败全部如下。除特别说明外都是 RPC `-32602` / `data.litch=invalidManager`。

| 校验位置 | 旧规则与触发条件 | 旧 field 信息 |
|---|---|---|
| 请求入口 `fields` | 参数必须是非数组对象 | 无 |
| 顶层 `keys` | 只允许 name/scope/rules/dispatch/contact/cwd/harness/model/effort/permission/template/firstTask | 未知键名 |
| 文本字段 | cwd/harness 非空文字；name/scope/rules/firstTask 必须为文字，可空 | 字段名 |
| 型号与强度 | model/effort 及 dispatch 的 harness/model/effort 必须为 null 或非空文字 | 字段路径 |
| 模板 | release/investigation/research/blank | template |
| 权限参数类型 | 非 null 时必须为非空文字 | permission |
| dispatch 结构 | 必须为对象，只收 6 个已知键，三个可空文本字段不可缺失 | 结构错误无；未知嵌套键旧版未加前缀 |
| 独立工作树 | worktree 必须为布尔 | 无 |
| 合并方式 | merge 必须为 manager 或 user | 无 |
| 并行数 | 正安全整数，1 到 9007199254740991；没有额外的 4/8/16 上限 | 无 |
| contact 结构 | 对象，只收 desktopNotification/unanswered | 结构错误无；未知键名 |
| 联系方式 | desktopNotification 布尔，unanswered 必须为 wait | 无 |
| 目录 | 设备平台的绝对路径，stat 成功且为目录；`~` 不展开 | cwd |
| 目录异常 | 不存在、无权限、文件路径等；旧实现把 try 内“不为目录”也捕获为“已有目录”错误 | cwd |
| harness 存在性 | 经理与显式子会话 harness 必须在设备配置表中 | 无 |

以下不是这句中文的直接来源：设备没有 litchManager 声明、连接离线、项目权限读取失败、权限档不受支持、引擎 thread/start 的普通错误、SQLite 异常。这些走各自错误码或通用连接错误；不能因为它们也阻止创建，就把它们归成同一根因。引擎若自行返回 `data.litch=invalidManager`，仍会命中同一映射，但夹具未发现此类引擎返回。

方法不认识：当前 main 已将标准 `-32601`、以及旧设备的 `invalidManager` 且消息以 `Unknown manager method` 开头，解释为设备服务较旧。I-60 所述更早客户端会将后一种错误误说成设置无效；在本次当前客户端里不是截图配置的复现根因。

## 客户端、设备与预填的原有差异

- 界面只在运行环境步骤检查目录非空、经理 harness ready；任务分配步骤检查正安全整数。基本文字允许全空，没有长度限制。
- 模型目录异步返回前保留预填值；返回后 `fitManagerHarness/fitManagerModels` 会清除失效 harness、模型和强度，回到有效默认值。原逻辑仅当已有型号/强度时才阻止未加载完成的提交。
- 设备原先只检查 model/effort 的文本形状，不核对模型目录或两者组合；dispatch 的失效型号、错误显示名和失效强度也能落库，问题可能在后续派线时出现，但不会在这一层触发截图中的错误。
- 规则文本没有显式长度上限；10 万字符规则、空名称、空范围、空规则都通过。本地预填会修复非法并行数、枚举和通知布尔值；目录删掉后仍会被记住，旧界面不会提前确认存在性。

## 版本与输入矩阵

脚本：`scripts/check-manager-create-versions.mjs`。把历史源码解包到临时目录编译，接隔离假引擎；每个输入分别直调设备（保留原始错误）和通过当前客户端核心调用（保留字段与双语文案）。不切换工作树，不使用个人凭据。

| 输入 | 3642addd / 0.29.0 / 全部 0.28.x | 修复后 |
|---|---|---|
| 截图配置，已有绝对目录 | 成功落库 | 成功 |
| 经理本身也用 Codex/Astra/high | 成功落库 | 成功 |
| `~` | cwd 非绝对路径失败 | 用目标设备 home 展开后成功 |
| `~/project`（目录不存在） | cwd 非绝对路径失败 | missingDirectory，同时给原输入和展开路径 |
| 普通相对目录 | cwd 非绝对路径失败 | 客户端逐步拦截；设备仍兜底 |
| 不存在的绝对目录 | cwd 已有目录失败 | missingDirectory |
| 指向文件 | cwd 已有目录失败 | notDirectory |
| 经理 harness 已移除 | harness 未配置，旧版无 field | harness / unavailableHarness |
| 子会话 harness 已移除 | harness 未配置，旧版无 field | dispatch.harness / unavailableHarness |
| 失效子会话模型与强度 | 成功落库（这层不查目录） | 对应模型或强度字段错误 |
| 显示名 GPT-6-Astra 当 ID | 成功落库 | unavailableModel |
| 并行数 0 / 小数 | invalidManager，旧版无 field | dispatch.maxRunningLines / positiveInteger |
| 最大安全整数 | 成功 | 成功 |
| 空名称、范围、规则 | 成功 | 成功 |
| 10 万字符规则 | 成功 | 成功 |
| scope=null | scope 文本类型失败 | scope / text |
| 隐藏的 unanswered=notify | contact 失败，旧版无 field | contact.unanswered / choice |
| 未知顶层字段 | invalidManager + 字段名 | unknownField |

代表性旧设备原始错误：

```json
{"code":-32602,"message":"cwd must be an absolute directory.","data":{"litch":"invalidManager","field":"cwd"}}
{"code":-32602,"message":"Harness removed is not configured.","data":{"litch":"invalidManager"}}
{"code":-32602,"message":"dispatch.maxRunningLines must be a positive integer.","data":{"litch":"invalidManager"}}
```

## 修复与覆盖

- `protocol/src/manager-validation.mts` 共用结构和型号/强度规则；设备最终核对自己的实时模型目录。
- `device/src/directory-validation.mts` 在目标设备展开 home，并区分相对路径、不存在、非目录和无法访问；创建前的项目权限读取复用同一规则，避免先在权限检查处拦下 `~`。
- `invalidManager` 保持原错误码，追加可选 field/reason/value/resolvedPath。新客户端收到旧设备缺失 reason 时保留已知字段，提示检查及升级，不猜具体原因。
- 表单逐步检查，显示设备解析路径；错误切回字段所在步骤、聚焦并设置 aria-invalid/aria-describedby；不丢草稿。
- `manager-store.mts` 未修改。手机没有创建经理表单；共享核心错误映射生效。
- 后续独立路径选择器提交覆盖情况见 [路径输入盘点](path-inputs.md)。

检查：设备与核心相关单测、界面步骤/预填单测、受影响包 typecheck、改动文件 Biome、隔离经理窗口冒烟。版本矩阵覆盖旧设备的原始错误和新核心映射。真实报告人输入、真实模型服务、Windows 与手机真机不在本轮已验证范围。
