# 候选准备与产物晋级

发版标准路径是 Prepare 一次，再 Promote 已验字节。独立 Gate 保留诊断用途；不需要先跑 Gate、再试出包、最后打标签重跑一遍。普通 push/PR CI 保留。

## 1. 冻结并准备候选

同步根版本、所有包/锁和 mobile app.json，更新日志，完成本地相关检查并由维护者推送候选分支。
版本号须在此时确定，不能在准备完成后再改。运行：

```sh
gh workflow run release.yml --ref <候选分支>
```

安排候选或 Mac 专项实验时，先查看正在执行/排队的 Mac jobs，尽量避开完整 Full 重叠。[GitHub 默认上限](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners)中 Free/Pro/Team 的 macOS 并发均为5，且标准与 larger runners共享该子上限。workflow 总状态 queued 不代表里面没有执行中的 job；应查 jobs 的状态和 runner 分配，不能仅按 workflow 总状态判断容量。未获 runner 和票据网络错误分别记录，不互相借用恢复预算。

Prepare 固定到本次工作流 SHA，门禁与五类打包并行。macOS 必须正式签名、Accepted、公证票据有效；Android 必须使用正式钥匙，验证证书、packageName、versionName、versionCode、非 debug 和 arm64 ABI。缺机密直接失败。

门禁必跑 CI 单测/契约/类型、桌面 smoke/critical/六入口首回合，另跑手机类型与原生 Markdown 单测。按 48 小时内全绿的祖先夜间选择完整领域；没有基线时跑全部非手机领域。

用户决定：手机模拟器 24 条 E2E 不参与任何发版候选，包含手机/共享代码变更和无基线情形。它们仍在夜间/手动 Full。手机单测、类型、正式 APK 与包验证不豁免。普通 push/PR 不跑模拟器，保持原状。

成功的 `seal` 汇总生成 `verified-candidate-<attempt>`，保存 14 天；Summary 给出 source run、验证 attempt、SHA、artifact ID 和带 `sha256:` 的 archive digest。每个平台和门禁/Full 分别登记真实来源 attempt，成功包不重签、不重公证。已有成功候选时，同 SHA 再次 Prepare 会停止并提示晋级来源。

## 2. 只读核对或草稿演练

Promote 使用含相同验证策略的已推送 ref；明确指定源候选，不找“最新同名 artifact”。

首次引入 `promote.yml` 时，先合入默认分支，让 GitHub 登记这个 workflow，再对目标 ref dispatch。只把新 workflow 推到候选分支，不能据此认定 dispatch 入口已经可用。正式首次运行先选 `verify`，核对入口和权限后再走草稿。例如：

```sh
gh workflow run promote.yml --ref <已推送验证分支> \
  -f source-run=<Prepare运行ID> -f source-attempt=<验证attempt> \
  -f candidate-sha=<完整SHA> -f artifact-id=<制品ID> \
  -f artifact-digest=sha256:<archive摘要> -f tag=vX.Y.Z -f mode=verify
```

`verify` 只有读权限，不创建 tag、draft 或公开版本。`draft` 验证后才创建缺失的同 SHA 标签和草稿，上传封存的文件并逐个下载回验，不修改 Latest。已有草稿必须带同一候选的来源标记；缺资产可补传，冲突资产拒绝覆盖。重复运行不重新上传相同资产，不构建任何包。

演练只针对明确授权的测试版本或 fork，结束清理自己创建的草稿/测试标签。不能借演练操作已经公开的版本。旧格式 dry-run 没有新的证明契约，不能直接冒充正式候选。

## 3. 人工批准后公开

维护者审阅 Summary、同 SHA 的源码/覆盖、每次首败、签名和包启动结果，核对**同一份 ZIP** 的隔离 ShipIt 验收。自动流程已验证 ZIP 内 App 的签名、票据和可写权限，但不能把这项静态验证描述成真实自动更新已验。断网首次启动条件不足时仍明确记为未验。

取得用户的本版公开授权后，把上述命令的 `mode` 改为 `publish`，并增加 `-f confirm-publication=vX.Y.Z`。这个输入是维护者对授权和审阅的明确确认，不是默认选项；已有授权不重复向用户询问。标签 push 本身不会触发准备或公开。

`publish` 同样先创建/核对完整草稿和回验；临公开再次检查来源 run 当前 attempt 成功、证明有效性、最新夜间、open release-blocker、标签实际 SHA、全部资产 ID/hash 和版本顺序。只能显式公开一次，已公开版本禁止覆写，旧版本不能抢 Latest。Promote 全局串行；不要同时排多个晋级请求，GitHub concurrency 只保留一个等待者。

草稿/公开后生成 `promotion-<attempt>`，含 `promotion.json` 和 `tap-inputs.json`。后者包含版本、真实标签源码 tar URL/hash、formula 路径及源 run/artifact 参数，可直接用于 Homebrew PR；不会自动修改或发布 tap。源码 hash 是标签 URL 的真实 bytes，不拿安装包 hash 或 commit tar hash 替代。

## 4. 失败、补验和证明边界

- 任何测试、出包或验证失败，都不封存可晋级候选。部分 Full、缺 run-ci、实际检出错误、未知证明不能冒充完整。
- 源 run ID 与 Promote 自己的 run ID 不同是正常情况；源 run 最新 attempt 必须成功。源运行开始新 attempt 后旧封存件不再可晋级。
- 测试重跑沿用源 run，已成功包引用原 artifact ID/创建 attempt。只重跑 Gate 汇总时可绑定较早成功的 Full artifact，不能伪造“本次重新实跑”。重跑后的新封存件有新 ID/digest，重新取 Summary 参数。
- 48 小时约束作用于增量夜间基线；已经完成全部非手机领域的同 SHA 证明不依赖旧基线。源制品缺失/过期、基线过期或验证策略变化时明确失败，不静默重建、跨 run 拼包或降低覆盖。
- 基线过期时可在原 run 补跑 Gate 影响范围 job 及其依赖，再封存；必须核对 GitHub 实际定点重跑范围，不能不加分辨地重跑所有成功打包。工作流策略变更后不能用新代码给旧候选盖章，需重新准备包含该变更的候选。
- 最新夜间仅手机模拟器领域失败且完整证明显示其余领域通过时，不阻断；`Nightly mobile follow-up` 创建修复 issue，不加 release-blocker。没有证明或其他领域红灯仍要求同 SHA 完整非手机验证或明确的既有分诊。任何 open release-blocker 仍拦截。
- 原手机 ADB 整片重跑预算不再用于发版，因为候选不跑模拟器。准备阶段/其他基础设施恢复规则不扩大；通用自动恢复和夜间缺跑监测分阶段交付。
- Apple 票据步骤只在原始输出明确包含 `NSURLErrorDomain -1005` 或 `Error 68` 时恢复：staple 和 validate 各最多三次，退避30/60秒，逐次失败原文写入 step summary。其他错误、超时或耗尽均失败；validate 恢复不重复 staple，更不重新提交公证。Accepted 不能替代票据成功。
- ARM 托管出包在票据命令期间临时阻断 UDP443，使其使用 TCP；只装载自己的 PF anchor，命令退出即撤销规则、释放 PF 引用。清理失败硬停止，不能被网络恢复掩盖。该规避来自[托管镜像已知问题](https://github.com/actions/runner-images/issues/14924)及本仓 ARM 对照；不是零故障保证，因此仍保留上述次数上限与检查点。本地普通出包不启用这项托管 runner 网络操作。
- macOS 在 Accepted 后先上传独立 `macos-notarized-<attempt>` 检查点，包含保真 App 归档、DMG、公证 UUID、团队和原始 hash。它不可分发，也不属于 verified-candidate。后续 attempt 只接受同 run/SHA、来源 Accepted/上传步骤成功、摘要匹配的检查点；恢复前再次查询 Accepted，再做票据、ZIP 和包验收，不重新签名或提交公证。检查点丢失、过期、损坏或身份不符直接停止，不能悄悄重做公证。
- 最终来源分别记录公证 attempt 与票据验证 attempt，Prepare/Promote 都核对原检查点的不可变 ID、digest 和来源步骤。GitHub 重跑 API 要等原 run 全部 job 结束后才接受；重跑仍须符合授权和预算，检查点不构成无限重跑许可，也不能把产品失败混入基础设施恢复。

## 5. 实施验收

本地 Node 24 跑 `node --test scripts/ci/*.test.mjs` 及根目录影响范围、Full/Release 策略/来源、公证专项。用 actionlint 检查工作流，人工确认 Release→Gate→Full→CI 的 `contents:read`/`actions:read` 权限继承。

GitHub 先在实施分支 ref 跑 Prepare 和 Promote `verify`，再在 fork/授权测试草稿范围演练 `draft`。核对：错误 SHA/run/attempt、损坏或过期 artifact、临时签名、产品与基础设施混合失败、重复请求、旧版本、标签移动都失败；晋级过程中没有测试、打包、签名、公证 job。确认原始首败仍可见且成功包 hash 不变。未经授权不演练公开。
