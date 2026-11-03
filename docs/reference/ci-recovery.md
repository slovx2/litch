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

审计 issue 标题为 `[CI recovery] run <id>`，不加 release-blocker。机器记录绑定源 run/SHA、原计划、规则版本、前条 hash、控制器身份和真实 Actions run。只信 GitHub Actions bot 并交叉核对控制器来源；重复 issue、缺链、来源变化和写入结果不可读回均停止。关闭 issue 不释放预算；发现可能处理过却没有账本，不默认为新预算。

先持久写 `reservation` 并读回验证，再复查源运行、Mac占用和整个计划；不一致则记 aborted，保留已占预算。API 响应不明确转 uncertain，只读确认下一 attempt，不再次 POST。控制器崩溃留下 reservation 同样不重发。恢复结果核对实际 job 执行区间、范围及原 artifact ID/digest；GitHub可能为沿用的成功 job分配新ID，所以用真实执行区间与steps核对是否重做，而非只比较job ID。

issue哈希链不是数字签名，不替代仓库维护者对凭据和写权限的管理。控制器只运行固定可信源码，不执行来源制品代码。读取作业只有 contents/actions read；恢复作业另外有 actions/issues write，没有 contents write、签名、发布或 tap 权限。固定串行组避免并发写；事件可能被替换，由有界 reconcile 补查。

## 上线与 Linux 验收

1. 先合入或登记**关闭状态**的控制器/fixture入口；保持 `LITCH_CI_RECOVERY_ENABLED` 未设为 `true`。由维护者推送已审代码到演练分支，冻结 SHA。不得拿本地未推代码的测试结果代替云端。
2. `recovery-fixture.yml` 在 `ci/recovery-nightly` 上分别执行 `case=infra`、`product`、`mixed`、`multi`，仅使用 Linux，不用真实模型、签名或机密。
3. 每个源 run 全部结束后，在同一 ref dispatch `recovery-controller.yml`，传 `source-run=<id>`、`mode=fixture-recover`。检查 infra/multi 只产生 attempt 2，包含必要的可复用下游；product/mixed 仍为 attempt 1，没有重跑请求。
4. 正向恢复结束后再 dispatch 同一控制器对账；核对 reservation先于API、原成功片的runner/时间未变、原制品 ID/digest 不变，下载其文本确认仍为原 SHA/run/attempt 1。重复执行控制器不得产生第三 attempt，也不得重传成功制品。
5. 本地替身还覆盖审计写失败、读回丢失、API响应丢失、竞态与错误来源；这些只报告为本地验收，不谎称云端故障实测。云端不伪造平台未获Mac，不为验收占满runner。
6. 确认真实演练通过后才设置仓库变量 `LITCH_CI_RECOVERY_ENABLED=true`；回滚将其关闭。签名相关恢复仍需按运行窗口协调。演练审计保留可追溯，可人工关闭但不删记录；不公开任何版本。

正式第一次启用应核对一次来源、权限与依赖范围，再扩展支持面。每次代码改变恢复契约都重新验收，不能用旧演练自动盖章。

## 夜间监测

夜间健康监测属于第三笔，尚未接线。已确定保留 Full cron：90分钟只在摘要提示，8小时未创建 run 告警、24小时升级疑似漏跑，同 issue 去重并显示心跳；绿色基线36小时提醒、48小时继续原规则。积累14次真实夜间样本后复核8小时阈值。GitHub内部监测也可能延迟，本轮不引入外部调度。
