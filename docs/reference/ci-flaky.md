# Full 偶发失败账

账本在 [`docs/ci/flaky-ledger.json`](../ci/flaky-ledger.json)。经理或集成线分诊 Full 后运行
`scripts/ci-flaky.mjs`，随修复或独立维护提交合入账目。使用版本管理文件，免去维护标签、
issue 正文计数及 CI 写权限；原来的 `nightly-triage` issue 保留用途和格式。

## 认定和计数

- 键是 **Full 中完整作业名 + 稳定用例名**。保留矩阵后缀和嵌套作业名，不将不同平台、
  分片、作业合并。Mac 探针以 `MAC_CHECK_RESULT.id` 为用例名，Node 测试使用完整标题。
  同一探针的截图或 evaluate 超时是同一用例，具体失败阶段记在每条记录里。
- 必须记录 run ID、attempt、job ID、实际 checkout SHA、作业开始时间（UTC）、
  触发方式、失败日志链接及通过依据。`head_sha` 可能与手动输入的待验 SHA 不同，不能直接使用。
- 同 SHA 的另一轮执行通过该用例，或维护者有可追溯的本地复跑通过记录，才计为偶发。
  同 SHA 的通过可以是同 run 的后续 attempt，也可以是另一个 Full 的执行。
  整个作业后面失败不否定已经通过的该用例；同一日志先失败后通过不算通过证据。
- 本地复跑依据由维护者负责核实，记下命令、源码 SHA/改动情况、环境、日期和通过结果，
  引用 issue、提交中的报告或保留的日志。脚本不自动证明本地报告的真实性。
  历史报告缺少字段时逐条如实注明，不补造 SHA 或宣称本次重跑。
- 只有失败、猜测慢机器、修复后的通过、另一 SHA 的 CI 通过，均不足以确认原失败偶发。
  登记 `pending`，保留待核实原因，不计入阈值；确定性产品/配置错误不当作偶发。
- **每个用例按独立 run ID 累计**，schedule 和手动 Full 都算；同 run 的多个 attempt
  留多条证据但最多计一次。重复执行记账命令幂等；可在原记录上补齐 pending 的通过依据。
  issue 数、日志重复摘要和分诊次数不加计数。修复、关闭 issue、成功运行均不清零历史。
  用例重命名或移作业时由维护者核对语义并迁移账本，不能借改名重置计数。
- **累计 3 次及以上，必须由经理在看板上提交“是否移出 Full”的用户决策**，附记录与覆盖影响。
  用户批准前保留原用例；继续计数并提示。脚本不会更改 Full、自动豁免失败、创建审批或批准移除。
  用户决定和对应变更应回填证据；若批准排除，手工把条目置为 `excluded` 并填写
  `exclusion.reason/reference`，保留历史。本账本不改变发版门禁或 nightly-triage 的判断。
- **手机模拟器 E2E 不进默认 Full 和 schedule**；`mobile-e2e` 默认 false，只有手动明确
  开启才运行。历史及按需执行的模拟器问题标注“已排除”，不计数。手机单测、类型、APK
  构建与验证仍保留，不能把这些失败也归入模拟器例外。

## 日常操作

需要 Node 和已登录、能读取本仓库 Actions 的 `gh`，不需要安装额外依赖。脚本仅使用 GET，
不触发工作流或改 GitHub 状态。`--attempt` 默认 1，避免重跑后误读最新 attempt。

```sh
# 只读提取失败名；支持 Mac/Client 汇总、Node spec/TAP、Go test
node scripts/ci-flaky.mjs scan --run 42313765563

# 自动确认同 SHA 的同用例通过；可指定 --pass-attempt 和 --pass-job
node scripts/ci-flaky.mjs record --run 42232742291 --job 'native / checks' \
  --case 'client:projections' --pass-run 42232742291 --pass-attempt 2

# 没有通过依据：先登记 pending；用例唯一时可以省略 --case
node scripts/ci-flaky.mjs record --run 42313765563 --job 'gate / unit'

# 本地复跑的报告（替换成真实记录；报告必须明确通过的是哪个用例）
node scripts/ci-flaky.mjs record --run 42349922482 --job 'native / checks' \
  --case 'client:adapter' --local-reference 'https://github.com/slovx2/litch/issues/35' \
  --note '维护者报告本机该脚本连跑三次、每次 30 项全过；原 issue 未记录本地 SHA。'

node scripts/ci-flaky.mjs summary
node --test scripts/ci/flaky-ledger.test.mjs
```

提取不到用例时，在核对日志后指定 `--manual --case '稳定名称' --failure-note '具体失败及位置'`。
结构化汇总只证明执行结果，不替代偶发依据。扫描输出未知/读取错误时必须人工检查；
日志过期而无法验证实际 SHA 的记录不能用脚本猜造，可根据已保存的原始证据人工补账并审阅。
所有子命令支持 `--ledger PATH`，可先在账本副本演练。

`record` 使用文件锁和原子替换；同 checkout 并发更新会明确失败，可在前一操作结束后重试。
进程异常退出留下 `.lock` 时先确认无人写入，再人工删除锁。跨分支合并时保留双方事件，
运行 summary 和测试检查去重，计数由事件计算，不维护易冲突的手工计数字段。

## 首次补账范围（2026-11-07）

核对 #33–#36，以及 API 返回的全部五次夜间 Full（2026-11-03 至 2026-11-06 UTC）。
不是所有历史手动 Full 的完整普查。实际记录、来源及待核实情况见账本 `audit` 和各事件。
投影的不同 CDP 失败按 `native / checks + client:projections` 归并，重跑不重复计数。


## 侧栏投影改为本地按需验收

2026-11-07 用户在 D-98 批准移出 `client:projections`。它原由 Full 的
`native / checks` → `nativePlan(['client'])` → `nightlyChecks` 进入固定窗口检查，
`check:nightly` 也复用这份清单；现从清单移除，仅保留脚本与
`npm run client:check:projections` 本地入口。其余窗口检查与门禁不变。
账本保留全部历史，标记 `excluded` 并记录批准依据，不再累计审批次数。

改动**侧栏、会话树、未读、运行中标识、置顶分组、设备色块**相关代码后，
在本地运行 `npm run client:check:projections`。先安装根目录与 UI 依赖
（`npm ci`、`npm ci --prefix packages/ui`），准备隔离的 Chrome for Testing；
可以用 `LITCH_CHROME_BINARY` 指定路径，否则脚本查找本机 Playwright 缓存中的 CFT。
脚本自动启动回环 Vite，使用独立临时 profile 和隐藏浏览器，不操作用户浏览器。
也可以用 `LITCH_PROJECTIONS_UI` 指向已启动的回环夹具。
此调整只改变运行位置，不删除或放宽验收断言；本地失败仍须排查后交付。
