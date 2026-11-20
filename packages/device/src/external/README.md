# 设备 GitHub 凭据和回写接线

- 从设备状态目录与同一个 `ExternalStore` 构造 `ExternalGithubSecrets`。私有管理员 RPC 使用 `identities`、`addIdentity`、`rotateIdentityCredential`、`revokeIdentityCredential` 和 `repositories`；启动时 `sweep` 清理未提交代及旧代。以 `botUserIds()` 给 C 提供防循环数字 ID；集合保留曾登记后撤销的账号，防止其历史活动在后补时触发。
- H 给采集传 `activeForRepository(repoId, preferredIdentityId?)` 的设备内快照。若有用户指定的身份且不可用，显式报不可用；无指定时设备只从读探针通过的活动凭据选用。平台明确拒绝某一代或指出组织审批时，调用 `invalidate(snapshot.metadata, fault)`；旧代拒绝不会断开新的活动代。快照含秘密，只能给设备适配器，不能进序列化结果。
- `GithubAgentLoginService.start` 在设备状态锁下启动。传私有 Unix socket 或 Windows named pipe（不监听 TCP）、可信的 gh/Git/Node 路径、实际分派 `assignmentForManager(managerId)` 与工作线归属检查 `isWorklineCurrent`。经理和工作线启动时从原宿主环境调用 `environment(actor, env)`；把返回环境给实际启动器，结束时 `dispose()`，设备退出时 `close()`。经理分配、来源暂停/恢复和 owner 变更落盘后调用 `refresh()`；凭据变更由服务直接订阅。用真实线程及工作线分派构造 actor。
- 经理绑定身份且开启注入时，普通 gh 调用的命令入口根据 `--repo`、API 仓库路径、`GH_REPO` 或本地 origin 选择对应所有者的私有 `GH_CONFIG_DIR`。Git HTTPS 使用仅匹配 github.com 的助手按仓库回调设备。未分配、仓库暂停、开关关闭、凭据失效或撤销时回到宿主；既有进程下一次取用也重新核验。SSH 和其他主机保持宿主行为。授权 Agent 能调用 Git/gh，自行取得或已经发送的 PAT 只能在 GitHub 侧吊销。
- `probeAgentGithubIdentity` 走同一个实际 Agent 启动环境，提示其 gh 是否为 owner；`checkIdentityRepositoryWrites` 给出仓库/机器人缺权或写权限未核验证据，不做探测性写入，也不挡保存分配。
- `ExternalGithubRead` 只接受已核准事件键或 X-n 的绑定主题；与 C 核对工具归属后调用。回写用 `ExternalGithubOutbox`，传同份经理分配回调，按经理身份代写。C 可把 `prepareTriageReply` 的结果放进 `commitTriage` 同事务；H 串行调度 `tick`、管理员单项 `reconcile/cancel`，把 `pendingDraft` 交给 B 处理未绑单 PR 的活动。默认没有提交状态写权；设置开启后还需 H 提供管理员确认的 `statusGateConfirmed`，已知用于门禁时仍拒绝。
- 即时反馈把 C 的 `ExternalFeedbackHost.enqueue` 接到 `outbox.enqueueFeedback(intent)`。它只消费 C 随入箱或真实投递持久化的意图，独立于经理的注入开关。状态评论更新等待创建回执，回写不确定时只查证；角色明确缺权或同代已收到写入拒绝时跳过，`checkIdentityRepositoryWrites` 返回诊断。不要在经理工具 schema 中开放这三个固定动作。
- 设备备份、诊断和运行环境日志排除 `external-credentials`、`external-agent-gh`、`external-outbox`。设备 RPC 只返回公有元数据和结构化诊断。产品手册与共同入口随 H 上线。

## GitHub CLI 授权（D-141）

- H 把官方 **gh 2.102.0** 及平台所需制品核验后安装到 `<runtimeRoot>/tools/github-cli/2.102.0/<platform>-<arch>/bin/gh[.exe]`；路径以 `bundledGithubCliPath` 为准。设备确认版本完全相等，从不搜索 PATH。根目录应由设备安装器管理；Linux、macOS、Windows 的发行打包和安装由 H 接入。
- 私有管理员 RPC 以 `GithubGhAuthorizationService.create({ secrets, stateDirectory, runtimeRoot, systemGithubConfig, changed })` 构造。分别映射 `add/importLogin/paste/get/cancel/confirm`；`changed` 只推 `{loginId, revision}`。开始设备码登录等待首个码或错误，最长等待提示 20 秒；桌面仅打开等待态中的固定 GitHub 网址。导入或粘贴等待完整的 API 核验，RPC 超时需覆盖多页读取。用新 `operationId` 重新开始已过期的登录；设备关闭时 `close()`。
- 新授权和导入核验 `X-OAuth-Scopes` 的三项必要 scope 和实际请求的可选 scope。OAuth 的公有 `resourceOwnerId` 仅作账本键；设备按每个仓库记录的真实数字所有者核验。OAuth 公共元数据包含 `credentialKind` 和实际 scopes。若为 owner，确认前只有短时私有暂存，未进入身份和路由。确认后 owner 会进入设备的机器人 ID 防循环集合；已在 GitHub 签发的令牌仍需在 GitHub 撤销。
- 导入仅运行 `gh auth token` 读取 `systemGithubConfig` 指定的目录；缺省遵循系统 gh 配置目录规则。高级细粒度 PAT 不需要 gh 二进制。设备备份另排除 `external-gh-logins`，此目录只有每次设备码尝试的私有临时配置。
