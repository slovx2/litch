# 桌面窗口检查分级

业务规则由 `client:test`（core）和 `client:test:ui`（UI）先检查。真实窗口负责启动、协议集成、输入、焦点、滚动和布局；不能用业务单测代替这些部分。夜间失败如已知影响候选版本，仍然阻断发布。

## 发版必跑

| 命令（仓库根目录） | 覆盖与准备条件 |
| --- | --- |
| `npm run client:smoke` | 隐藏 Electron 启动、主进程/核心/界面连接与首屏 |
| `npm run check:critical --prefix apps/desktop` | 关键审批：焦点、旁处回车不批准、Esc 拒绝、后续工具审批、批准后返回输入框；输入法不误发、发送一次并完成。模拟核心和隔离 Pi 入口各一遍 |
| `npm run client:check:first-turn -- --engines codex,claude,dsh,opencode,acp` | 六入口真实 harness 的新会话首回合；Pi 自动包含。各 CLI 必须由 `CHA_*_CLI` 指向隔离安装，禁止 `--skip-missing` 作为发布绿灯 |
| `node apps/desktop/scripts/smoke.mjs --packed` | 本次打包产物启动、首屏及核心/界面链路；macOS 必须使用本次已签名包，在签名之后执行 |

关键审批/发送命令要求已构建 UI、Pi、设备及 Go CLI，和原 `compose:entry` 的准备相同。不加载真实用户的模型凭据。签名/产物检查属于打包 job，不能拿开发版 smoke 替代。

原 `client:check:packed` 仍保留完整的包内启动、长发送探针和远程连接；打包、入口与远程相关变更可继续跑它。小门禁的最小要求是上表的签名后启动命令，由发布工作流负责接入。

## 本地按需验收

`npm run client:check:projections` 不再进入 Full 或 `check:nightly`。改动侧栏、会话树、未读、运行中标识、置顶分组或设备色块后，在本地运行此命令；原脚本与断言保持不变。依赖和隔离 Chrome for Testing 的准备方式见 [侧栏投影本地验收](../../docs/reference/ci-flaky.md#侧栏投影改为本地按需验收)。

## 夜间全量或按影响范围

以下原命令继续保留完整断言。`node apps/desktop/scripts/check-nightly.mjs` 按 Full 的 native / checks 中 client 领域顺序运行同一组窗口检查，只构建 UI/桌面一次；不自动重试，逐项报告失败和耗时。依赖、Pi、device、Go CLI 及隔离 Chrome 须事先准备。

| 命令 `client:check:*` | 受影响时至少加跑 |
| --- | --- |
| `scroll`、`scroll:entry` | Transcript、窗口化/分页、流式增量、布局和滚动补偿 |
| `compose`、`compose:entry` | 输入框、请求卡片、草稿、附件、提问、计划、分叉/编辑、评论 |
| `full`、`sidebar` | 聚合设备、多 harness、侧栏/工作区/菜单、声明能力 |
| `manage`、`harness-settings` | 设备设置、harness 开关/重启、设置冲突、运行时信息 |
| `settings`、`text-scale` | 主题/字号/缩放、菜单、语言、布局边界 |
| `navigation` | 历史、模态窗口、导航焦点和快捷键 |
| `terminal`、`files`、`diff` | 对应侧面板及 fs/process/git 协议 |
| `adapter`、`ssh`、`remote` | 本地适配器生命周期、远程连接及恢复 |
| `engines` | harness/protocol/core 变更；保留重启、编辑、分叉等长链路 |
| `first-turn` | 同时属于发版必跑，不能仅放夜间 |

`tasks`、`tree`、`background`、`goal`、`manager*`、`onboard`、`pair`、`upgrade`、`tools*`、`chrome` 及桌面包里的 browser/computer-use 检查仍按各自领域执行；它们不在原 Full 的 client job 中，不能将该 job 的计时称为所有桌面领域的耗时。

共享 core/protocol/device、构建脚本或依赖锁变化时扩大相关集合；仅按叶子目录判断不足以保证覆盖。`search` 保留独立命令，其 CI 排除原因已有专门记录，不计作本次提速收益。

## 下沉对应关系

| 窗口断言 | 单测 | 窗口保留 |
| --- | --- | --- |
| 长历史完整性不能以同时挂载的 DOM 回合数判断 | `packages/core/test/history-paging.test.mts`：24 回合两次打开，逐个核对回合标识、用户消息、回答、去重与顺序 | 实际旧历史加载、首尾问题锚点、切走切回滚动位置 |
| 归档提示悬停保持、离开后重新计时 | `packages/ui/test/toast-lifetime.test.mjs`：真实组件效果、事件处理与虚拟计时；含键盘焦点、更新重计时和关闭 | 归档/撤销按钮、恢复、选择和提示更新 |
| 草稿的存储隔离 | `packages/ui/test/draft-isolation.test.mjs`：文字/图片/附带项及提问草稿跨设备、会话隔离 | 真实输入与粘贴、焦点、缩略图、组件切换后的草稿恢复 |

## 两周失败排查口径

2026-11-02 用 `gh run list` 和 Actions jobs/logs 只读核对 10-19 起的 Full：79 个完成且非取消的 run，含各 attempt 共 43 个 client 系列失败 job。按首败步骤计数，后续跳过不算成功，重跑不隐藏首败。

| 步骤 | 次数 | 分类和证据边界 |
| --- | ---: | --- |
| compose:entry | 8 | 探针/夹具竞争与产品表现待区分；历史有停止回合竞争修复，另有少一条排队消息，当前基线未复现 |
| search | 5 | 未定，已从 Full 移出；不计作本次收益 |
| full | 5 | 菜单/侧栏状态契约陈旧、恢复后发送时序；旧报告的尺寸持久化失败不能只凭日志认定纯探针问题 |
| engines | 4 | 另一条线负责，不修改 |
| compose | 4 | 分叉侧栏行计数、菜单时序、立即发送；当前修改以会话/回合标识等待，不放宽内容判断 |
| manage | 3 | 设置项增加后的陈旧期望、前一场景结果尚未更新、Pi 停用等待；原始失败原因分别保留 |
| scroll | 3 | 回答增长等待、折叠位移失败、切回首帧锚点移动 1182px；后两种仍属于产品表现候选。当前基线通过不证明历史根因已消除 |
| projections | 2 | 环境缺 Chrome、CDP Promise 被回收各一次；已有修复，当前基线通过 |
| scroll:entry | 2 | 把首批 DOM 当完整回合数，以及旧“无项目”选择器；本次补分页完整性测试并通过加载入口查首尾锚点 |
| text-scale | 1 | 产品表现候选：human 评论框越界；当前基线通过，根因未独立复现，不改阈值 |
| harness-settings | 1 | 等不到离开确认；当前基线通过，未复现历史根因 |
| remote | 1 | 连接阶段期望与重复设备文案不一致；契约维护候选，未逐项复现 |
| ssh | 1 | 只读探测留下状态文件；产品表现候选，未复现历史根因 |
| files、diff、settings | 各 1 | 日志只核到步骤失败，根因未定，保留原窗口覆盖，不算本次已修缺陷 |

分类不等于缺陷结案：明确环境错误单列；有具体计数/选择器/夹具证据的列探针问题；布局越界、消息缺失、实际状态不更新在排除产品问题前继续按产品表现候选处理。不得因为 timeout 就宣布 flake。

直接记录示例：[分页只画八回合](https://github.com/slovx2/litch/actions/runs/40483517770/job/122119469457)、[分叉落点超时](https://github.com/slovx2/litch/actions/runs/41282956777/job/124778442529)、[恢复旧会话后发送未被接收](https://github.com/slovx2/litch/actions/runs/40673323049/job/122765338495)、[评论框越界](https://github.com/slovx2/litch/actions/runs/41370941759/job/125041086187)。不保存原始日志或截图。

## 本地验收（2026-11-02，macOS / Node 24.10.0）

`check`、`client:typecheck`、核心 1060 项和 UI 479 项全部通过。最终 nightly 的 25 个窗口/连接子步骤全部通过；没有自动重试。新探针最初误在内部按钮读取会话 ID 的失败已修正，以下三轮均在修正后执行。

| 修改的窗口部分 | 连续三轮耗时（秒，均通过） |
| --- | --- |
| compose / session（模拟） | 238.99 / 238.74 / 238.42 |
| compose / session（真实 Pi） | 63.17 / 54.43 / 52.86 |
| full（真实多 harness） | 16.60 / 16.65 / 16.11 |
| manage（真实设备） | 19.15 / 17.99 / 15.24 |
| scroll:entry | 8.19 / 7.39 / 7.11 |
| critical（模拟） | 2.73 / 2.66 / 2.59 |
| critical（真实 Pi） | 6.01 / 5.07 / 5.00 |
| machine-enable（默认不留截图） | 2.48 / 2.22 / 2.09 |

比较的是原 Full/client 的同一窗口集合，不含安装依赖、引擎构建和其他 job。原脚本逐命令重建 UI/桌面，新 nightly 只构建一次；既有滚轮矩阵、终端、文件、外观、侧栏与协议集成覆盖保留。

- 原首次基线含类型/单测：980.98 秒，但 manage、ssh、remote 因 Node 所在目录带真实 codex 被夹具安全拒绝而提前退出。改用只有 Node/npm 的隔离目录、指定同版 Node 头文件后补齐三项，逐项总和 1123.05 秒。**这不是一次全绿的基线墙钟。**
- 扣除原类型及单测 27.98 秒，原窗口集合校正合计 **1095.07 秒（18 分 15 秒）**。
- 最终同集合实跑 **952.54 秒（15 分 53 秒）**，约少 **142.53 秒 / 13.0%**。没有达到 8–12 分钟目标，也没有测云端 runner 的收益。
- 关键审批/发送单独执行约 7.6–8.7 秒，加桌面构建首轮命令共 12.60 秒。六入口首回合与签名包启动另计，不能把这个数字叫完整发版门禁耗时。

没验：`taskpolicy -b` 的 compose 在既有 300 秒整轮上限终止，无断言结果；未放宽超时，不能报告慢机压力通过。随后普通优先级连续三轮通过。

没验：本线未重新跑六个真实 harness 首回合、probe-engines 或签名包；只完成当前分工内的窗口集合和真实 Pi 夹具，相关集成仍由对应门禁负责。

没验：旧 CI 的评论框越界、首帧位移、少一条排队消息等产品表现候选未独立复现；当前全部窗口通过不等于历史根因结案。本轮未确认新的产品缺陷。
