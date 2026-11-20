# GitHub 收件箱：C 线接线

此页记录设备接口。客户端设置、实际启用无人值守及兼容验收由 H 线接入。

## 采集与收件箱

- 全设备共享同一 `ExternalStore`，B 线用 `new SqliteGithubPollStore(externalStore)`。受限凭据按来源交给 `createGithubExternalVerification(apiFor, sourceById)`。它复用 B 的角色查询、仓库/内容核验和分页；返回 `lookupGithubRole`、`recheckEvent`、`inspectSubject`、`snapshotLabels`。
- C 的三个 host 和 `ExternalIntakeService` 共用一个同步的 `configuration()`，从 F 的配置存储读 `configuration/get` 的形状：`revision / identities / repositories / assignments`，包括未分配的本机身份。它要能在经理库事务内读取；不要改成 RPC 或异步读取。用 `repositoryRouting(snapshot, repoId)` 取仓库视图；保存前调用 `validateExternalRoutes(repo, routing, managerLookup)` 判同仓库重复身份和无效归属。来源中的 `credentialRef`、`botUserId` 只核验实际采集凭据。
- 构建 `ExternalDispatch` 和 `ExternalIntakeService(store, verification.lookupGithubRole, dispatch.queue, verification.recheckEvent, configuration)`。轮询提交后或设备恢复时，按启用的仓库调用 `intake.consumeGithub(poll.evidence, {sourceId, repoId}, now, verification)`。每次至多消费 100 条，再调用 `intake.processReceived(sourceId, now)` 恢复分类和有界角色重试。每仓库只采集一次。C 复取当前公开正文，按该仓库已分配身份的已核验登录名匹配并保存数字 ID，原始证据不改写。外部正文不入库。多经理同时被提及仅入箱，等人工改派。默认 `litch` 标签发给仓库唯一经理。
- 仓库配置入口核验实际根目录、凭据与授权。分类、受理和发送都重检当前作用域、配置版本和本机身份集合。来源未启用时不消费该源。收到 `configurationChanged` 后刷新配置投影和调度。
- `dispatch.pressure(managerId)` 提供待送组、限额、等待时间和最早准入时间；收件箱待分拣/覆盖水位仍从各自的账本读取。客户端通知由 H 出站过滤并按影响范围发 `inboxChanged`。

## 即时反馈

- 启用时构建 `ExternalFeedback(store, {configuration, language, enqueue})`，同一实例给 `ExternalDispatchHost.feedback` 和 `ExternalIntakeService` 的可选第六参数 `{service: feedback, waitReason: dispatch.feedbackReason}`。H 可用 `feedbackWaitReason(manager, sourceId)` 标明忙碌或暂停，C 会核算限额。配置快照仓库的 `immediateFeedback` 省略时默认开启。
- 收件与实际确认两次分别同事务保存固定意图，不占模型工具或经理自发回复。调度器按仓库调用 `feedback.flush({sourceId, repoId})`。D 的 `enqueue(intent)` 重新验证目标经理的身份、范围、写权限和开关，将意图按稳定键持久入 outbox，返回 `queued`、`skipped` 或 `retry`。更新带 `createKey`，用 D 的创建回执编辑原评论；原操作待对账时不得新建另一条评论。评论用经理所分配的身份发，程序文案不引入外部正文。

## 经理、工具及权限

- `managerBundle(manager, native, taskCards, externalTools)` 和 `managerTools(manager, taskCards, externalTools)` 中的第四/第三参数是 D 提供的读取与回写工具定义；传空数组只装 C；省略它保留旧工具和指纹。创建、指纹比较、刷新/重置使用同一个 bundle。调用 `externalManagerUpgrade(manager, {threadId, fingerprint}, expectedBundle)`；只有当前线程确认应用了完整 bundle 才可启用自动提醒。拒绝时引导使用现有刷新（Claude Code）或重置（其它引擎）。角色规则刷新保留是否已经安装外部工具的状态。
- 用 `ExternalManagerTools` 接 `isExternalManagerCall(name, args)` 命中的调用。身份 `{managerId, threadId, harness, turnId}` 从设备当前工具调用取得，不从参数取得。H 提供 `ExternalMandateHost.isCurrentTurn` 核验真实运行回合（含切换、停止、重置等保护），实现会在等待 GitHub 后再核对。普通 `answer` 和讨论区照旧；携带 `ownerEventKey` 的 `answer` 另带 `expectedDecisionRevision`。外部工具不注册给工作线。
- 接单/并入/忽略的可选回复通过 D 的 `prepareReply` 生成受约束的私有载荷引用，实际入队和处置同事务；评论开关关着时返回 `comment_disabled`。D 使用的回写凭据和只读工具继续由 D 的入口控制。
- 绑定 `onIssueCreated` 到 `managers.issues.onExternalCreated`（事务内关系、未读），`onIssueChanged` 到 `managers.issues.onExternalChanged`（提交后通知）。详情从 `getWithExternal` 读，出站用 A 的 `projectExternalManagerPayload`，同时检查实际接收连接的两个扩展、调用者权限。不要把外部引用填进普通评论。
- `external_link` 校验现行仓库、分配、目标问题版本和当前经理回合，已绑定返回冲突。默认发现 Agent PR 时留 `agent_pr_needs_link`，不唤醒。若用户启用自动关联，给 `ExternalLinkService` 配置 `resolveAgentPr`，将 `links.observeAgentPr` 包装成 `consumeGithub` 的第五个参数。解析只匹配账本中设备签发的 `<!-- litch-operation:… -->`（与 D 一致）或已登记的分支。服务还会验证 PR 作者是被选经理身份的数字 ID、PR 实际 head 仓库和已有同仓库绑定。本机所有身份的动作都不算触发；带 Agent 标记的 owner 正文不作为 owner 指令或决策答复。
- 设备管理入口可使用 A 的 `reassignIntake` 处置未绑定候选，应先验证管理员身份和新经理的仓库根目录。C 能识别已有改派审计；不将改派自动当作新的 GitHub 唤醒授权。

## 发送、停止和对账

- H 在启动和调度时对稳定的经理 ID 调用 `dispatch.drain(id)`。使用会话树同一线程串行路径，`reason='external_event'` 仅跳过普通回报的长空闲和每用户消息预算；保留来源 `unattended.autoNotify`、当前线程、工具能力、归档、用户停止、待审批/答复、后台、重置交接及计划续跑保护。忙时只在该回合可安全插入时投，否则保留。`canDeliver` 必须同步从设备实时状态重检这些保护。按 D-137，执行隔离只报告就绪信息，不作为唤醒门槛。
- 会话树等完引擎状态和 `thread/resume` 后，用 `prepare()` 构造请求。调用引擎连接的最终发送钩子时，再用同一 prepared 数据调用 `beforeSend(prepared)`；返回 null 应取消该请求。此钩子在同事务写 `deliveries`、`external_deliveries` 和额度，不能从普通入库、预览或纯读取提前调用。引擎的请求幂等身份用 `prepared.eventId`（组 ID 派生），确认需真实 `turnId`；明确未发回 `not_sent`，事后无法判断回 `unknown`。
- 普通经理 drain 必须先用 `queue.deliveryGroupForDelivery(deliveryId)` 排除外部组。恢复时只在接管状态目录后调用 `dispatch.recover()`，将未确认的 sending 转为 unknown。对账按引擎事件/回合确认后用 `dispatch.confirmDelivery(groupId, turnId, now)`，以便一并确认收件箱和第二阶段反馈；有明确未发的证据才可处置为 blocked。unknown 保留稳定标识并挡同经理自动发送，不能被重启计划重放为新回合。
- 停止 X-n 跟进或解决/关闭时，`ManagerIssues` 同事务封住尚未发送的绑定组；候选和绑定历史不迁移。已经发送不明的组只对账。终态上的显式人类新请求留待人工分拣，可关联新内部 X-n，原绑定不变。
