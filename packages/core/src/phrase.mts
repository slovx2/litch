// 核心自己要对人说的话。
// 核心不认识语言：它只给出“说的是哪一句”和里面要填的值，由界面按当前语言说出来。
// 这样切换语言是界面自己的事，不用让核心把数据重新投影一遍。
// 每一句的各语言文本在界面包的 i18n 目录里，那边有类型检查保证这里的每一句都有对应的文本。

export type PhraseKey =
  // 设备
  | 'device.local'
  | 'device.catalogFailed'
  // 完整模式：会话目录里有的 harness 这次没取到，留着的是它上次的会话
  | 'device.catalogPartial'
  // harness 为什么不可用
  | 'harness.connecting'
  | 'harness.unreachable'
  | 'harness.handshakeFailed'
  | 'harness.disconnected'
  | 'harness.starting'
  | 'harness.disabled'
  | 'harness.notInstalled'
  | 'harness.versionTooLow'
  | 'harness.startFailed'
  | 'harness.stopped'
  | 'harness.unavailable'
  // 设备服务自己回的几种错误
  | 'fault.harnessUnavailable'
  | 'fault.unknownHarness'
  | 'fault.unknownThread'
  | 'fault.unknownThreadMaybe'
  | 'fault.noHarness'
  // 这个会话正被别处的 codex 用着，这边现在动不了它；只读地打开时在对话上面说的那一句
  | 'fault.heldElsewhere'
  | 'session.heldElsewhere'
  // 带图片的消息不能中途插进回合里（它所属的 harness 声明了引导时带不了图片）
  | 'fault.steerImages'
  // 整理侧栏：工作区、归属、置顶
  | 'fault.organizeUnsupported'
  | 'fault.workspaceName'
  | 'fault.workspaceRoot'
  | 'fault.workspaceGone'
  | 'fault.sectionName'
  // 连接
  | 'connect.noEntry'
  // 本机内置的适配器：启动它的设备服务这一步，和没起来的几种原因
  | 'connect.adapterStarting'
  | 'connect.adapterBroken'
  | 'connect.adapterLegacy'
  | 'connect.adapterStartFailed'
  | 'connect.adapterTimeout'
  | 'connect.socketMissing'
  | 'connect.socketRefused'
  | 'connect.socketDenied'
  | 'connect.closed'
  | 'connect.dropped'
  | 'connect.cancelled'
  | 'connect.handshakeFailed'
  | 'connect.heartbeat'
  // 远程设备：经 ssh 连过去的每一步，和各种没连上的原因
  | 'ssh.step.connect'
  | 'ssh.step.probe'
  | 'ssh.step.start'
  | 'ssh.step.startService'
  | 'ssh.noClient'
  | 'ssh.unreachable'
  | 'ssh.hostKeyUnknown'
  | 'ssh.hostKeyChanged'
  | 'ssh.auth'
  | 'ssh.config'
  | 'ssh.timeout'
  | 'ssh.failed'
  | 'remote.notInstalled'
  | 'remote.broken'
  | 'remote.outdated'
  | 'remote.startFailed'
  | 'remote.proxyFailed'
  // 远程设备上的设备服务（适配器）：命令行太旧、在跑的是不带聚合面的旧服务、起不来、起来了接不上
  | 'remote.serviceTooOld'
  | 'remote.serviceOutdated'
  | 'remote.serviceLegacy'
  | 'remote.serviceStartFailed'
  | 'remote.serviceProxyFailed'
  // 会话
  | 'session.untitled'
  | 'session.readOnly'
  // 引擎自己的子代理线程，对面说它不接受直接输入（canAcceptDirectInput 为假）：只能看
  | 'session.agentReadOnly'
  // 导进来的原生会话正被本机另一个进程开着（Claude 桌面端、终端）：只能看，对方放手后自动恢复
  | 'session.nativeOwned'
  | 'session.archived'
  | 'session.queueFailed'
  // 终端
  | 'terminal.limit'
  | 'terminal.unsupported'
  | 'terminal.notRunning'
  | 'terminal.endOffline'
  // 文件面板：路径不在工作区里、根不认识、对面不会、网络共享上的目录还不支持
  | 'files.outside'
  | 'files.unknownRoot'
  | 'files.unsupported'
  | 'files.searchUnsupported'
  | 'files.network'
  // 差异面板：目录不在了、这里不能暂存和还原、有冲突的文件不在这里处理、确认之后文件又变了
  | 'diff.rootMissing'
  | 'diff.notWritable'
  | 'diff.conflicted'
  | 'diff.moved'
  // 定时任务：这台设备的服务不支持、任务没了、别处先改过了、任务数到了上限
  | 'tasks.unsupported'
  | 'tasks.gone'
  | 'tasks.conflict'
  | 'tasks.limit'
  // 工具调用
  | 'tool.failed'
  | 'collab.source'
  | 'collab.spawnAgent'
  | 'collab.sendInput'
  | 'collab.resumeAgent'
  | 'collab.wait'
  | 'collab.closeAgent'
  | 'collab.sendMessage'
  | 'collab.followupTask'
  | 'collab.interruptAgent'
  | 'collab.listAgents'
  // 一行说明
  | 'notice.hookPrompt'
  | 'notice.subAgentActivity'
  | 'notice.imageView'
  | 'notice.imageGeneration'
  | 'notice.slept'
  | 'notice.enteredReview'
  | 'notice.exitedReview'
  | 'notice.unknownItem'

export type PhraseArgs = Record<string, string | number>

export interface Phrase {
  key: PhraseKey
  args?: PhraseArgs
}

/** 一段给人看的文字：要么是对面或用户给的原文，要么是核心自己要说的一句话 */
export type Text = string | Phrase

export const phrase = (key: PhraseKey, args?: PhraseArgs): Phrase =>
  args ? { key, args } : { key }

/** 写日志、报错时用：把一段文字变成不依赖语言的一行 */
export function describeText(text: Text): string {
  if (typeof text === 'string') return text
  return text.args ? `${text.key} ${JSON.stringify(text.args)}` : text.key
}

export function sameText(a: Text | null, b: Text | null): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a === 'string' || typeof b === 'string') return false
  return a.key === b.key && JSON.stringify(a.args ?? {}) === JSON.stringify(b.args ?? {})
}
