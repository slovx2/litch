# 设备 GitHub 凭据和回写接线

- 从设备状态目录与同一个 `ExternalStore` 构造 `ExternalGithubSecrets`。私有管理员 RPC 使用 `identities`、`addIdentity`、`rotateIdentityCredential`、`revokeIdentityCredential` 和 `repositories`；启动时 `sweep` 清理未提交代及旧代。以 `botUserIds()` 给 C 提供防循环数字 ID；集合保留曾登记后撤销的账号，防止其历史活动在后补时触发。
- H 给采集传 `activeForRepository(repoId, preferredIdentityId?)` 的设备内快照。若有用户指定的身份且不可用，显式报不可用；无指定时设备只从读探针通过的活动凭据选用。平台明确拒绝某一代或指出组织审批时，调用 `invalidate(snapshot.metadata, fault)`；旧代拒绝不会断开新的活动代。快照含秘密，只能给设备适配器，不能进序列化结果。
- `GithubAgentLoginService.start` 在设备状态锁下启动。传私有 Unix socket 或 Windows named pipe（不监听 TCP）、可信的 gh/Git/Node 路径、实际分派 `assignmentForManager(managerId)` 与工作线归属检查 `isWorklineCurrent`。经理和工作线启动时从原宿主环境调用 `environment(actor, env)`；把返回环境给实际启动器，结束时 `dispose()`，设备退出时 `close()`。经理分配、来源暂停/恢复和 owner 变更落盘后调用 `refresh()`；凭据变更由服务直接订阅。用真实线程及工作线分派构造 actor。
- 经理绑定身份且开启注入时，普通 gh 调用的命令入口根据 `--repo`、API 仓库路径、`GH_REPO` 或本地 origin 选择对应所有者的私有 `GH_CONFIG_DIR`。Git HTTPS 使用仅匹配 github.com 的助手按仓库回调设备。未分配、仓库暂停、开关关闭、凭据失效或撤销时回到宿主；既有进程下一次取用也重新核验。SSH 和其他主机保持宿主行为。授权 Agent 能调用 Git/gh，自行取得或已经发送的 PAT 只能在 GitHub 侧吊销。
- `probeAgentGithubIdentity` 走同一个实际 Agent 启动环境，提示其 gh 是否为 owner；`checkIdentityRepositoryWrites` 给出仓库/机器人缺权或写权限未核验证据，不做探测性写入，也不挡保存分配。
- `ExternalGithubRead` 只接受已核准事件键或 X-n 的绑定主题；与 C 核对工具归属后调用。回写用 `ExternalGithubOutbox`，传同份经理分配回调，按经理身份代写。C 可把 `prepareTriageReply` 的结果放进 `commitTriage` 同事务；H 串行调度 `tick`、管理员单项 `reconcile/cancel`，把 `pendingDraft` 交给 B 处理未绑单 PR 的活动。默认没有提交状态写权；设置开启后还需 H 提供管理员确认的 `statusGateConfirmed`，已知用于门禁时仍拒绝。
- 设备备份、诊断和运行环境日志排除 `external-credentials`、`external-agent-gh`、`external-outbox`。设备 RPC 只返回公有元数据和结构化诊断。产品手册与共同入口随 H 上线。
