# 经理看板分页验收

2026-11-03。本轮只使用 `treeRig` 临时库、假引擎、隔离 Chrome 和临时回环 OpenSSH；没有连接用户设备或读取用户状态。

## 读取契约

新能力为 `litchManagerPaging`，设备在 `runtime/info.device.extensions` 宣告，当前连接必须在 initialize 同时声明它和 `litchManager`。六个方法使用 `litch/manager/` 前缀：

| 方法 | 用途 |
| --- | --- |
| `catalog/read` | 轻量经理目录及全板计数，不构建完整看板 |
| `board/summary` | 计数、局势、待定决策第一页、最近 10 条动态、工作线快照和返回经理的关联编号索引 |
| `objects/list` | `kind/status/order/cursor/limit` 查询，返回 `entries/total/nextCursor` |
| `object/read` | 指定 ID 的完整当前对象、帖子、讨论、相关关系及重开信息；不附旧版本 |
| `object/history` | 指定对象按 seq 倒序取变更页，返回 `changes/nextCursor` |
| `lines/read` | 最近快照；`refresh:true` 独立向引擎核对 |

列表与历史默认每页 30 条，上限 100 条。界面使用“加载更多”，保留各类别、状态、排序的已加载页和滚动位置。已答复、已关闭、已完成等状态按需加载。对象头只含标题、状态、版本、时间及至多 160 字符预览。

工作线头字段使用 `reportPreview`（至多 240 字符）、`unverifiedCount`、`checkedAt`；整个结果另有 `checkedAt/failed`。核对不阻塞首屏，失败保留旧快照。未核对状态明确显示，不凭缺少会话数据推断为空闲。`lineReferences` 仅传工作线到对象编号的映射，保留工作线返回经理的关联入口，不带关联对象正文。

游标绑定经理、种类、状态和排序。对象、报告和建议用既有 rowid 固定创建上界，再按创建时间和稳定序号翻页；同秒新插入不进入已有游标。历史用既有 seq 固定上界。状态并发改变后，由失效通知重建已加载页，游标不是跨请求事务快照。

建议读取使用提案库现有线程索引，仅取头字段；包含已开始、已取消、撤回、过期等已了结状态，不再误用只返回 pending 的旧 `allSuggestions()`。没有迁移、加表或加索引。

旧 `list` 和 `board/read` 的语义、返回结构保持不变。新客户端未发现分页能力时使用原接口。没有新增主动通知、全板修订序号或对象增量订阅；继续使用按连接声明投递的经理失效通知。

## 回包与对账

答复成功回包立即更新决策状态、当前已加载列表的归属、总计数和已加载帖子版本；待定页不跳转。失败保留条目与草稿并显示原因。时间线、动态、其他状态列表的新成员、详情依据等由后台对账补齐。

后台只重读摘要、已加载查询的相同页数、已打开的详情与历史范围，不读取未打开的状态。普通答复复用一次后台对账；确有在途旧结果或其他并发失效时才补读，避免把成功结果覆盖回去。桌面通知独立遍历开放议题头字段，第一页之外重新打开的决策仍能通知。

## 测量边界

标准夹具为 60 条决策（20 条待定）、100 条事项、每对象 15 条变更，共 2400 条历史、50 条工作线。扩大量为 1600 个对象、24000 条历史，仍为 50 条工作线。每次引擎读取固定模拟 20ms，工作线并行核对。

设备和核心分段取 7 次中位数。首帧是正式界面订阅看板到双 requestAnimationFrame 后的可见卡片，取 3 次中位数；不包含 Electron/Expo 进程启动、Vite 编译或 SSH 建连。旧路径与分页路径使用同一客户端、夹具和机器，分别强制旧能力和声明新能力。SSH 使用真实 OpenSSH 的本机回环端口转发，已建立连接；不是公网或用户远端测速。手机数据来自正式 React Native 页面在 Web 预览中的运行，不代表真机 Hermes 帧耗时。

## 实测与验收

### 实测结果

JSON 净载荷不含 WebSocket 帧和握手。标准夹具完整看板 **10,807,850 B**，分页摘要核对工作线后 **35,577 B**（减少 **99.67%**）；刚启动、尚未核对工作线时约 **32.4 KB**。目录另约 1.2 KB，独立工作线核对返回约 17.7 KB，不在首屏阻塞链上。10 倍规模：完整看板 **108,041,600 B**，摘要 **55,342 B**。

| 标准夹具阶段 | 旧完整读路径 | 分页路径 |
| --- | ---: | ---: |
| 设备目录读取 | 80.154 ms | 6.906 ms |
| 设备看板 / 摘要读取 | 79.492 ms | 9.012 ms |
| JSON 序列化 | 13.493 ms | 0.088 ms |
| 本机 WebSocket 传输 | 28.340 ms | 0.228 ms |
| 回环 SSH 内 WebSocket 传输 | 52.590 ms | 0.508 ms |
| JSON 解析 | 15.414 ms | 0.089 ms |
| 核心投影与分页缓存发布 | 1.851 ms | 0.219 ms |

这些阶段由不同的隔离基准测量，不能直接相加当作端到端启动时间。传输基准中 SSH 首次建连约 54 ms，两条路径相近。

| 订阅看板至首帧 | 旧完整读路径 | 分页路径 |
| --- | ---: | ---: |
| 桌面、本机 | 316.8 ms | 79.1 ms |
| 桌面、回环 SSH | 311.0 ms | 76.5 ms |
| 手机页面 Web 预览、本机 | 468.2 ms | 113.6 ms |
| 手机页面 Web 预览、回环 SSH | 515.3 ms | 105.8 ms |

【事实】原路径把全部对象和 2400 条完整变更一起发给客户端；分页路径的首屏没有详情和历史 RPC。两端的断言确认已答复 30→40 条、事项排序、报告已阅、已了结建议、失败重试与答复成功移出待定。普通答复仅发一次摘要对账，重读已加载两页及已打开的详情/历史，没有旧 `board/read`。

【推测】真实远程连接上的大载荷等待会下降；真实网络、引擎和手机原生渲染的收益不能用上述回环/Web 数据代替。

### 查询计划与索引

- 对象页：`SEARCH objects USING INDEX sqlite_autoindex_objects_1 (manager_id=?)`，排序 `USE TEMP B-TREE FOR ORDER BY`。
- 对象历史：`SEARCH changes USING INDEX changes_manager (manager_id=? AND seq<?)`，对象 ID 是 JSON 残余筛选。
- 标准 / 10 倍规模摘要分别为 **9.012 / 23.619 ms**；旧完整读分别为 **79.492 / 604.229 ms**。
- 最老对象的历史页分别为 **10.138 / 96.442 ms**。提案按已有 `proposals_by_thread` 的线程列范围读取头字段，不读完整简报。

本轮无需新增索引即可达到首屏缩小目标，也没有进行任何存储迁移。若按对象历史成为瓶颈，候选是 `changes(manager_id,json_extract(body,'$.objectId'),seq)` 表达式索引；它需要单独获准的迁移，本轮未创建。

### 复跑

先用 Node 24 构建 `packages/device` 和 `packages/core`。夹具 JSON 由 `scripts/bench-manager-board.mjs` 生成。

```sh
node scripts/bench-manager-paging.mjs /tmp/manager-board-after.json 1 /tmp/manager-paging-bench-final.json
node scripts/bench-manager-paging.mjs /tmp/manager-board-after.json 10 /tmp/manager-paging-large-final.json
node scripts/bench-manager-board-transport.mjs /tmp/manager-board-after.json
node scripts/bench-manager-board-transport.mjs /tmp/manager-paging-bench-final.json --summary
node scripts/check-manager-paging-ui.mjs /tmp/manager-board-after.json
```

界面脚本支持 `--mobile`、`--ssh`、`--legacy`。检查首屏不读详情或历史、跨页加载、筛选计数、排序、滚动恢复、详情与历史按需读取、读取失败重试、答复失败与成功、仅一次后台对账、报告已阅、已了结建议、事项详情和编号深链。所有测试进程及临时手机入口在退出时清理。

局部单测覆盖扩展声明门控、旧完整读、游标作用域和同秒插入、历史上界、建议已了结状态、JSON schema、工作线核对失败、核心在途回包防倒退、已加载范围对账、第一页外通知，以及两端原有草稿和编号规则。

检查结果：设备/核心相关 42 项、桌面相关 26 项、手机相关 17 项单测通过；device、core、ui、desktop 和手机原生/Web TypeScript 检查通过；手册检查通过。新增分页路径在桌面/手机 × 本机/回环 SSH 四组正式界面夹具中通过，旧能力四组启动路径通过。已查看两端首屏和详情截图。改动文件 Biome 无错误；保留原有桌面 probe 的 3 条和经理 CSS 的 6 条警告。

页签小改独立提交 `67c508ea`；分页协议与设备查询 `08f46d6f`；核心缓存与对账 `33eb98d2`；两端界面、按需详情和回归收尾 `62528a75`。性能脚本与本文在最后一笔提交。均在 `feat/manager-board-paging` 本地提交，未推送。

没验：手机原生 Hermes 真机上的帧耗时与触摸滚动；本轮使用正式页面 Web 预览。

没验：用户实际远端设备、真实 SSH 网络及真实看板；本轮严格使用隔离夹具。

没验：仓库 Full workflow；按约定由经理在 GitHub 统一运行，本线未触发。

## 改动文件

```text
apps/desktop/src/probe-manager.mts
apps/mobile/e2e/flows/mock/19-manager-workbench.yaml
apps/mobile/src/detail/issue-links.ts
apps/mobile/src/preview/scenes.web.ts
apps/mobile/src/screens/managers/IssueMarkdown.tsx
apps/mobile/src/screens/managers/ManagerConsoleScreen.tsx
apps/mobile/src/screens/managers/ManagerLines.tsx
apps/mobile/src/screens/managers/ManagerOverview.tsx
apps/mobile/src/screens/managers/PagedBoard.tsx
apps/mobile/src/screens/managers/relations.ts
apps/mobile/src/screens/managers/use-origin.ts
apps/mobile/test/manager-workbench.test.mjs
docs/reference/manager-board-paging.md
packages/core/src/channel/protocol.mts
packages/core/src/connection/link.mts
packages/core/src/connection/manager-protocol.mts
packages/core/src/core.mts
packages/core/src/device/device.mts
packages/core/src/device/manager-paging.mts
packages/core/src/device/manager.mts
packages/core/src/model-manager.mts
packages/core/src/projection/manager-paging.mts
packages/core/test/manager-board-fixture.mts
packages/core/test/manager-paging.test.mts
packages/device/src/device.mts
packages/device/src/manager-lines.mts
packages/device/src/manager-page-query.mts
packages/device/src/manager-paging.mts
packages/device/src/manager-posts.mts
packages/device/src/manager-relations.mts
packages/device/src/manager-store.mts
packages/device/src/manager.mts
packages/device/src/session-store.mts
packages/device/src/session.mts
packages/device/test/manager-paging.test.mts
packages/protocol/src/device.mts
packages/protocol/src/manager-paging.mts
packages/ui/src/i18n/en-manager.ts
packages/ui/src/i18n/zh-CN-manager.ts
packages/ui/src/manager/BoardPanels.tsx
packages/ui/src/manager/BoardReferences.tsx
packages/ui/src/manager/Decisions.tsx
packages/ui/src/manager/ManagerPage.tsx
packages/ui/src/manager/PagedBoard.tsx
packages/ui/src/manager/references.ts
packages/ui/src/styles/manager.css
packages/ui/src/tree/SuggestionsPage.tsx
packages/ui/test/manager-references.test.mjs
protocol/extensions/manager.json
scripts/bench-manager-board-transport.mjs
scripts/bench-manager-paging.mjs
scripts/check-manager-mobile.mjs
scripts/check-manager-paging-ui.mjs
scripts/manager-paging-rig.mjs
skills/litch-manual/references/managers-and-suggestions.md
```
