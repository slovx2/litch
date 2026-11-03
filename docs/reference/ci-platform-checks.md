# CI 检查集合与平台对照

`scripts/ci/check-catalog.mjs` 为可复用检查定义稳定ID和命令。调用方先安装依赖、构建引擎/设备/Go，并用 `install-test-clis.mjs` 安装精确版本的隔离CLI；`run-checks.mjs` 默认只构建一次UI/桌面，然后逐项执行。已有同job构建可传 `--built`，它只免去构建，不跳过检查。

| 集合 | 覆盖来源 | 必要前置 |
|---|---|---|
| desktop-unit | CI/client类型、core/UI及桌面六组单测 | 各包依赖 |
| desktop-portable-unit | desktop-unit除去浏览器整组；浏览器保留原Mac覆盖 | 各包依赖 |
| desktop-required | smoke、真实Pi冒烟、critical两种模式、首回合探针回归单测、六入口首回合、原生Codex/客户端工具、adapter | 引擎/设备/Go产物、全部隔离CLI |
| dsh | Full/dsh单测、真实SSH | DSH依赖与隔离CLI |
| opencode | Full/opencode完整单测 | OpenCode依赖与隔离CLI |
| client-engines | Anthropic夹具单测、原三引擎完整窗口检查 | 全部引擎/设备/Go产物、Claude/DSH CLI |
| real-engines | 六入口首回合、原生Codex/客户端工具、后台工具与唤醒、重启恢复、经理夹具单测与真实入口 | 全部引擎/设备/Go产物、全部隔离CLI |
| real-engine-tools | real-engines中除首回合、原生Codex、客户端工具外的五项；前三项由desktop-required完整覆盖 | 同上 |

多个集合同时执行时，重叠ID只执行一次，报告仍保留完整请求集合。CLI版本保持原Full/CI基线，Claude用2.1.282；`protocol/versions.json`里的Claude TUI专项版本不代替这个基线。ACP复用同一隔离OpenCode。

执行器使用临时HOME/XDG，清除个人模型凭据与设备路由；缺CLI、失败、中断、Node测试跳过或空用例清单都会失败，不自动重跑。报告包含SHA/run/attempt、平台、Node/CLI版本、精确命令清单、每个检查的结果和Node用例清单。报告只在明确指定`CI_CHECK_REPORT`时落地；云端对照制品保留7天。

`mac-equivalence.yml`在同一SHA的Mac ARM和Linux x64上执行相同集合，再校验命令、实际Node用例名称/数量、来源与版本。它不签名、不发布，也不会自动改变Full/Gate的覆盖。未登记到默认分支的新工作流，需要维护者安排一个已登记的分支专用入口才能首次实跑。

对照成功仅证明这次执行的命令与可观察用例一致，不能证明所有操作系统行为相同。迁移前仍要审阅平台条件、原生调用和skip分支。完整窗口集合包含macOS快捷键、标题栏/侧栏留白、Computer Use设置等差异，仍由原Full/client在Mac覆盖；Swift、LaunchServices、签名/公证和Darwin原生行为不因Linux绿灯被删除。当前引入共享入口和对照工具，正式工作流尚未迁移。

末项失败时，默认整轮对照仍拒绝。分诊可调用`compareChecks(left, right, originalSuites, { only: selectedSuites })`只核对原计划中的完整子集：原始报告保持不变，结果标明`selected-subsets`及两份原始`complete`状态。所选检查缺失、失败、skip、来源或实际用例不同仍拒绝；这份结果不能作为完整领域或门禁的成功证明。

浏览器组中的mac-keychain有三个仅macOS执行的原生用例，另有一个显式环境开关启用的可选NSS用例。整组不能按纯JS迁移。对照工作流选择明确命名的`desktop-portable-unit`，不改`desktop-unit`原清单，不修改浏览器测试断言或既有skip条件；这部分继续由原Mac命令执行。严格对照器不会把带skip的完整集合误报为可迁移。

六入口首回合在Linux对照中曾命中Claude回话内容不完整断言。探针已修复等待平滑动画定稿，并增加三项回归；共享清单也在首回合前执行这三项。修复后的同SHA对照重新包含`desktop-required`，通过前保留原Mac覆盖。`client-engines`排在其他子集后执行；若仍命中流式分段断言，整组留Mac，按日志中的有界时间/长度序列另行分诊，不修改阈值或采样频率。`desktop-required`与`real-engine-tools`合起来仍覆盖原real-engines全部检查，须实际绑定两份成功来源后才能用于门禁，不能只凭子集成功宣布整域通过。
