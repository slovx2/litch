# CI 基础设施恢复与审计

代码包含只读观察器、持久审计和有界恢复控制器。**正式自动恢复默认关闭**：仓库变量 `LITCH_CI_RECOVERY_ENABLED` 不存在或不为 `true` 时，不执行事件驱动或定时恢复。必须先完成下述 Linux 合成故障验收，再启用该变量。

## 只读观察

维护者在已审核的源码上使用 Node 24：

```sh
node scripts/ci/recovery-observe.mjs <run-id>
```

只调用本仓库 GET API，输出分类和 `observation`，可追加 `GITHUB_STEP_SUMMARY`。`recovery-controller.yml` 的手动 `mode=observe` 作业同样只有读取权限；两个入口都声明 `checks: read` 读取 GitHub Actions 检查注解。日志 ZIP 由 runner 自带的 Python 3 标准库在内存里精确读取，不依赖不同平台的 tar 格式支持。审计不复制环境、秘密或原始输出，只保存固定原因、来源链接与证据 hash；读取失败仅报告固定阶段，不输出 API 异常内容。

## 可恢复范围

- 准备故障：精确锁定的 checkout、setup-node、setup-go 步骤；只允许准备动作先行。必须从唯一对应步骤文件读到最后一条明确网络错误，不能挑先前已恢复的网络词。权限、证书、校验和、配额、内部恢复耗尽均排除。npm 安装可能执行生命周期脚本，不泛化成安全下载。
- 未获 runner：runner ID 零、名称为空、无 steps，且有 GitHub Actions 明确的未获 hosted runner 失败注解。容量 notice、queued 时间长、人工或并发取消不够。
- 产品、未知、混合失败不恢复；手机、SDK和票据既有恢复预算不叠加。公证 Rejected、签名或证明损坏不重跑。
- 汇总或签名协调作业仅在受审位置发出明确上游失败标记、依赖图里确有可恢复首败时，才能归为派生失败；普通缺证明或未知错误仍阻断。

默认仅信任本仓库默认分支的祖先提交。源 SHA/run/attempt、当前默认分支及本地受审工作流和恢复代码/依赖契约都须匹配。旧编排、fork、PR和未注册分支不建议自动恢复。Linux 演练另有明确限定：只允许 `ci/recovery-nightly` 的同一冻结 SHA、同一套控制器及 fixture 文件；合成错误识别不用于正式工作流。

## 预算、依赖和审计

每个源 run 一轮，每个逻辑片最多一次，只处理 attempt 1；必须等整轮结束。解析受审 YAML 的本地调用、静态矩阵和 needs，不执行表达式；不支持的动态矩阵/外部工作流、身份不唯一或循环都拒绝。签名协调的 API 等待边单独登记，不能冒充 GitHub 的声明依赖。

只有全部失败根可分类，且重跑集合不会重复已成功的测试或包，才进入写入。单根用 job rerun，多根或明确派生失败用一次 failed-jobs rerun；纯汇总可重算，同 SHA 已成功制品保持原 ID/hash。签名协调没有声明的等待边由失败集合恢复覆盖。

涉及 Mac 且其他工作流有运行/排队 Mac 时记 `deferred`，不占用恢复预算；从源 run 结束起最多等两小时，到期记录 blocked。GitHub 内部 reconcile 也可能迟到，因此它不是准时调度保证；过期不会补跑。每轮最多检查五个来源，超出的 ID 在 summary 明示，不能把截断列表报告成全部已处理。

审计记录放在**已关闭、带 `ci-recovery` 标签的 issue** 中，标题为 `[CI recovery] run <id>`，不加 release-blocker。标签不存在时自动创建为灰色 `ededed`；创建 issue 时就带标签，确认记录后立即关闭，关闭确认成功后才允许恢复 API。关闭失败保留原 reservation，不重建 issue 或重置预算。后续评论和对账始终读写同一条已关闭 issue，查询包含所有状态，不因标签缺失而忽略历史预算。

机器记录绑定源 run/SHA、原计划、规则版本、前条 hash、控制器身份和真实 Actions run。只信 GitHub Actions bot 并交叉核对控制器来源；重复 issue、缺链、来源变化和写入结果不可读回均停止。发现可能处理过却没有账本，不默认为新预算。写接口只额外允许创建这一固定灰色标签和关闭 issue，不允许任意 PATCH、重开、发布或删除。

先持久写 `reservation` 并读回验证，再复查源运行、Mac占用和整个计划；不一致则记 aborted，保留已占预算。API 响应不明确转 uncertain，只读确认下一 attempt，不再次 POST。控制器崩溃留下 reservation 同样不重发。恢复结果核对实际 job 执行区间、范围及原 artifact ID/digest；GitHub可能为沿用的成功 job分配新ID，所以用真实执行区间与steps核对是否重做，而非只比较job ID。

issue哈希链不是数字签名，不替代仓库维护者对凭据和写权限的管理。控制器只运行固定可信源码，不执行来源制品代码。恢复写作业固定全局串行；夜间通知使用独立串行组，避免关闭开关后的空事件挤掉夜间监测。事件可能被替换，由有界 reconcile 补查。

补偿每轮最多五个来源，按 Actions 检查点中的游标轮转。已完成且来源未变的结果不占名额；错误来源推进游标但仍保留待查状态，不能一直排在最前。每轮写前固化选中的来源 ID，失败后也上传检查点，下一轮核对 run/attempt/SHA、制品 digest 和实际上传作业后续扫。检查点只证明扫描范围，不能代替恢复 reservation。没有可信检查点时明确 bootstrap；无法核实曾处理过的来源仍保守阻断。遇到服务端 1000 条查询上限直接失败，不把截断列表当完整结果。

## 上线与 Linux 验收

1. 先合入或登记**关闭状态**的控制器/fixture入口；保持 `LITCH_CI_RECOVERY_ENABLED` 未设为 `true`。由维护者推送已审代码到演练分支，冻结 SHA。不得拿本地未推代码的测试结果代替云端。
2. `recovery-fixture.yml` 在 `ci/recovery-nightly` 上分别执行 `case=infra`、`product`、`mixed`、`multi`，仅使用 Linux，不用真实模型、签名或机密。
3. 每个源 run 全部结束后，在同一 ref dispatch `recovery-controller.yml`，传 `source-run=<id>`、`mode=fixture-recover`。检查 infra/multi 只产生 attempt 2，包含必要的可复用下游；product/mixed 仍为 attempt 1，没有重跑请求。
4. 正向恢复结束后再 dispatch 同一控制器对账；核对 reservation先于API、原成功片的runner/时间未变、原制品 ID/digest 不变，下载其文本确认仍为原 SHA/run/attempt 1。重复执行控制器不得产生第三 attempt，也不得重传成功制品。
5. 本地替身还覆盖审计写失败、读回丢失、API响应丢失、竞态与错误来源；这些只报告为本地验收，不谎称云端故障实测。云端不伪造平台未获Mac，不为验收占满runner。
6. 确认真实演练通过后才设置仓库变量 `LITCH_CI_RECOVERY_ENABLED=true`；回滚将其关闭。签名相关恢复仍需按运行窗口协调。演练审计保留可追溯，可人工关闭但不删记录；不公开任何版本。

正式第一次启用应核对一次来源、权限与依赖范围，再扩展支持面。每次代码改变恢复契约都重新验收，不能用旧演练自动盖章。

## 夜间监测

夜间监测并入 `recovery-controller.yml` 的现有 `8,23,38,53 * * * *`，不另建 cron。**恢复开关关闭时，夜间监测仍运行**；它只读 Full 并跟进告警，不触发 Full、恢复产品测试或发布。真实夜间 Full 完成事件也会触发核对。

- Full 的 `17 19 * * *` 保持原样；90分钟未创建只在摘要提示，8小时告警、24小时升级疑似漏跑。已创建但等待 runner 单独呈现。跨日的新 run 不填补前一天缺口；同一槽多个 run 明示归属歧义。
- 绿色基线核对同 run/attempt/SHA 的完整 Full 证明；36小时提醒，48小时仍由候选原门禁退回全量。本监测不改祖先条件，也不把手动 dispatch 当夜间。
- 同一条 `[CI nightly] 夜间调度与绿色基线跟进` issue 去重升级，状态不变最多每小时刷新一次，恢复后关闭，再次异常重开；这条是待办告警，与已关闭的恢复审计不同。责任人为 Litch 开发经理，由经理分诊并安排修复。不自动添加 release-blocker，也不解除既有发版阻断。
- 手机模拟器当前仅手动按需运行。对于历史夜间，只有完整非手机证明且实际失败只涉及模拟器，才能标记“仅修复、不挡发版”；APK、未知或其他领域失败仍按既定规则跟进。
- 每次定时维护保存 `ci-nightly-health-<attempt>` 心跳；CI 和 Prepare 只读展示，最多花20秒，读不到明确报未知，不影响原门禁。心跳间隔超过90分钟会在摘要提示监测自己迟到。GitHub 全面漏调度时，本机理不能独立实时告警。
- 只累计真实 `event=schedule` 的独立 Full run；同 run 的重试与手动 dispatch 不增加样本。达到14次后提示经理复核8小时阈值。创建时间只能推定最近的 cron 槽，超过一天的调度延迟不能唯一归槽。

合入后的验收顺序：保持恢复变量关闭；先在默认分支手动 dispatch `mode=nightly-observe`（无需 source-run），确认只读权限和当前摘要；再等待真实维护 schedule，核对心跳上传及 CI/Prepare 展示。随后观察真实夜间 Full 的创建、结果、告警去重与心跳闭环。**手动演练不能验收 I-94**，也不能替代14个真实样本。新增审计标签/自动关闭还需用同冻结SHA的 Linux fixture 验证；正式开关仍须用户另行同意。

首次没有可信心跳时，摘要明确显示“首次观测，之前的监测空窗无法核实”，不据此猜测漏跑槽数。后续使用实际前一份心跳计算间隔；已有90分钟等阈值不变。

## 隔离的只读扫描演练

`recovery-scan-drill.yml` 只有手动入口、Linux runner 和 `contents: read`、`actions: read` 权限。它用8个固定的合成来源调用正式纯选择器与收据函数，不查询或恢复真实失败来源，不写审计issue。合成来源1模拟已成功的attempt2，其他来源模拟仍需跟进；模拟收据不代表真实恢复成功。

演练使用独立工作流、artifact名`ci-recovery-scan-drill-1`和JSON kind。正式维护只接受schedule、正式工作流和`ci-recovery-scan`，不会把演练检查点纳入预算历史。来源按明确run ID下载，不自动选择“最新”；须同ref、同SHA、attempt1、成功首轮，核对上传job/step、ZIP digest与检查点身份，再重放固定夹具核对游标及收据。API错误、缺制品或损坏立即拒绝，不回退为空游标。

合并后保持恢复开关关闭，由维护者在同一冻结提交的ref上执行三次（将下方`<冻结ref>`和`<首轮run-id>`替换为实际值）：

```sh
gh workflow run recovery-scan-drill.yml --repo slovx2/litch --ref <冻结ref> -f phase=seed
gh workflow run recovery-scan-drill.yml --repo slovx2/litch --ref <冻结ref> -f phase=resume -f source-run=<首轮run-id>
gh workflow run recovery-scan-drill.yml --repo slovx2/litch --ref <冻结ref> -f phase=reject-corrupt -f source-run=<首轮run-id>
```

1. `seed` 成功：选中`1,2,3,4,5`，剩余`6,7,8`，游标5；模拟成功来源1持有terminal收据。独立artifact含正常检查点和明确标记的`bad-checkpoint.json`（游标故意为-1）。
2. `resume` 必须等待首轮完成。成功后选中`6,7,8,2,3`、剩余`4,5`、游标3；来源1成功收据原样保留、不再占名额，两个轮次合计覆盖8个来源。下载第二轮检查点核对`parentRun`与首轮run ID一致，并与实际两次run的SHA/attempt/上传digest逐项比对。
3. `reject-corrupt` 仍指向同一成功首轮，读取真实上传ZIP中的损坏夹具。**预期工作流失败**，扫描步骤摘要必须明确“演练检查点内容损坏”，上传步骤skipped且没有新artifact。若只是准备失败、API失败或通用身份拒绝，不算损坏反例通过。
4. 三次均不得出现恢复API、审计issue写入、Mac job或正式`ci-recovery-scan-*`制品。错误SHA/ref/attempt、篡改成功收据等另有本地测试；未云端实测时如实列为未验。

三次dispatch必须保持同一SHA；若main前进，可由维护者按授权冻结专用分支。不得通过放宽SHA校验续验旧检查点。演练不接正式恢复开关，也不能替代真实schedule心跳继承或I-94验收。
