# 计划模式与审批映射

基线：Codex 协议 0.163.0、Claude Agent SDK 0.3.282、宿主 CLI 2.1.282。

## 用户行为

- 客户端选择计划模式，或 Claude 调用 EnterPlanMode，都会持久保存会话模式并发送 thread/settings/updated。
- AskUserQuestion 通过 item/tool/requestUserInput 等待用户回答，一次调用的几道题在同一条请求里。选项原样给客户端、原样收回；“选项之外自己写”用题目上的 isOther 表示，不补假选项。答案按 SDK updatedInput 的正式结构返回，不能伪装为工具拒绝；没答的题不出现在给模型的结果里。
- 原生计划文件仅可写入项目内 `.claude/plans/codex-harness-adapter/<threadId>/` 目录；这是 CLI 支持的相对路径配置，每个线程独立且禁止符号链接逃出项目。计划内容以 plan item 和文本增量发给客户端，项目源码仍不能在计划模式中写入。
- ExitPlanMode 要求用户明确选择“执行计划”。选择“继续规划”、取消或中断均不会放行执行；只写了话、没选“执行计划”的不算确认，话随拒绝原样交给模型。选了“执行计划”同时又带了话的算确认：话作为执行时的补充并进计划，随计划一起交给模型。
- 确认退出后更改真实 SDK permissionMode，再同步会话模式；退出不改变用户的文件系统权限。只读会话退出计划后仍然只读。
- 子代理不能修改父会话的计划模式。
- 重启、恢复和后续提交使用持久化模式；读取历史不发起模型请求。
- 工具审批“拒绝”只拒绝本次工具；“取消”持久化中断当前回合并等待原生 CLI 停止，队列暂停，剩余条目须由明确操作继续。
- 审批用哪种请求：命令是 item/commandExecution/requestApproval；MCP 工具调用是 mcpServer/elicitation/request（表单为空，`_meta.codex_approval_kind` 是 `mcp_tool_call`，和原生 Codex 相同），答 accept 并带 `_meta.persist: "session"` 表示这个会话里这个工具都允许；改文件和其余要问的自带工具是 item/fileChange/requestApproval。

## 权限映射

| 客户端选择 | Codex 参数 | Claude 执行行为 |
| --- | --- | --- |
| 完全访问 | never + danger-full-access | default 模式配合宿主回调允许工具，支持 root Worker；保留提问和计划确认 |
| 工作区 | on-request + workspace-write | SDK default + 工作区/网络沙箱；需要审批的动作回调用户 |
| 只读 | on-request + read-only | 允许读取，禁止项目写入和有副作用工具 |
| never + 受限沙箱 | 原始参数 | 不允许通过审批扩大权限，失败返回模型 |
| untrusted | 原始参数 | 非读取工具必须经用户审批，不能被 SDK 用户 allow 规则直接放行 |
| granular | 五个布尔字段完整保留 | 按请求类别决定是否可发起审批；false 为拒绝，不是自动允许 |

granular 的 sandbox_approval 对应命令审批，rules 对应规则强制审批与文件工具，skill_approval 对应 Skill，request_permissions 对应原生权限请求，mcp_elicitations 对应 MCP 服务发来的表单/URL 请求。MCP 工具调用的审批虽然也是征询的形状，归 rules 管，不受 mcp_elicitations 影响。SDK 明确标记 matchedAskRule 时以 rules 为准。未知值和非当前 schema 的旧别名返回 -32602。

配置文件和环境变量不得把客户端选定的只读或计划模式放宽。计划限制由每次调用的 PreToolUse 检查执行，而不只依赖返回标签。

完整 `sandboxPolicy` 会保存 `writableRoots`、`networkAccess` 和两个临时目录排除选项，重启、恢复、分叉及元数据更新不能丢失这些边界。原生 Bash 每次经过 macOS Seatbelt 或 Linux bubblewrap，审批显示模型的原始命令；不能用 SDK 默认临时目录规则或用户 allow 规则扩大权限。计划模式对 Bash 强制只读和禁网，确认退出后恢复用户原有策略。缺少操作系统沙箱时明确拒绝执行，不降级放行。

## 自动化证据

- PLAN-001：提问、输出计划、同意/拒绝退出、实际文件副作用；只读配置退出后仍不能写入。
- PLAN-002：AI 进入计划、计划文件、重启恢复、显式退出后的真实执行。
- PLAN-004：计划确认时自己写的话不放行，原话到模型。
- QUESTION-001 至 004：一次三道题（选项、跳过、自己写）、一道与四道及多选、名为 Other 的选项与自己填的 Other、回合被打断时提问作废。
- APPROVAL-004：文件审批同意、拒绝、取消及完全访问免审批。
- PERMISSION-004：严格 schema、untrusted、never + 只读、granular 开关及重启恢复；MCP 工具授权与表单开关分别验证真实文件副作用。
- PERMISSION-005：完整沙箱策略跨进程恢复，真实文件工具验证工作区、额外目录、符号链接外逃及网络禁用。
- PERMISSION-006：真实 Bash 验证目录越界、联网开关、只读与计划模式、完全访问，断言文件内容和本地站点请求数。
- Tyrs Hand PERMISSION-007：双 SSH 入口验证移动端使用的 thread/settings/update 完整保存权限，切回完全访问生效，配置过程无模型请求。
- Tyrs Hand PLAN-003：双真实 SSH 客户端经过 Worker/Hub，仲裁计划回答、命令和文件审批；同一个操作只能产生一次副作用。
- FAILURE-003：对真实 CLI 发送 SIGSTOP/SIGKILL，验证有界终止、审批结束事件先于回合终态、迟到接受无副作用、恢复请求包含原生上下文及取消工具结果。工具执行前意图先记进入口的库（不等 CLI 写会话记录）；调用已经执行、还没进会话记录时 CLI 或入口崩溃，下一回合告诉模型这次调用结果未知，不当它没发生过（tool-intent 的 INTENT-004）。

运行 npm test 和 npm run test:protocol；通过 CHA_CLAUDE_CLI 指定独立安装的固定 CLI。后者禁止访问公网模型，只运行固定 SDK/宿主 CLI 和本地 Mock LLM，并输出 schema 检查、JUnit、wire 和模型请求证据。
Linux 全部测试位于隔离网络 namespace。macOS 的 Bash 沙箱测试必须单独运行，因为 Seatbelt 不支持嵌套；此用例使用临时 HOME、白名单环境、虚拟密钥和强制回环的模型端点，并单独记录隔离方式和 JUnit，不能声称具有外层 OS 禁网。

这些用例不代表完整产品发布验收。MCP OAuth、全部故障路径、真实桌面/手机 GUI 和完整协议矩阵仍受主项目 releaseReady 门禁约束，不能以协议驱动冒充 GUI 验收。
