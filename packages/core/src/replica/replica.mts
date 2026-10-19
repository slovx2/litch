// 界面这一侧的数据副本：订阅通道上的主题，把快照和增量落到按键的状态库里。
// 它不含任何界面框架的代码，界面只需要把“订阅一个键”接到自己的渲染机制上。
import type { CoreChannel } from '../channel/client.mjs'
import {
  type AppOp,
  type ChannelErrorShape,
  type ManageOp,
  type SessionOp,
  type SidebarOp,
  type TasksOp,
  toChannelError,
} from '../channel/protocol.mjs'
import type {
  AppView,
  DeviceView,
  HarnessId,
  ItemView,
  QueuedMessage,
  RequestView,
  SectionView,
  SessionAbilities,
  SessionSettings,
  SessionSummary,
  SessionView,
  SidebarView,
  TurnView,
} from '../model.mjs'
import type { DiffScope, DiffView } from '../model-diff.mjs'
import type {
  InheritedEnvView,
  ManageView,
  SettingGroupView,
  SettingSpecView,
  SettingsSnapshotView,
} from '../model-manage.mjs'
import type { PairingTopicView } from '../model-pairing.mjs'
import type { TaskRunView, TasksView, TaskView } from '../model-tasks.mjs'
import type { TerminalInfo, TerminalsOp, TerminalsView } from '../model-terminal.mjs'
import type { SessionNoteView, SessionProposalView } from '../model-tree.mjs'
import type { Text } from '../phrase.mjs'
import { changedKeys } from '../projection/manage.mjs'
import { appendOutput, appendSkipping } from '../text/output-cap.mjs'
import { createFileTrees, type FileTrees, fileKeys } from './file-trees.mjs'
import { KeyedStore } from './keyed-store.mjs'

/** 状态库里有哪些键、每个键放什么 */
export const keys = {
  /** string[]：设备标识，按添加顺序 */
  devices: 'devices',
  /** DeviceView */
  device: (deviceId: string) => `device:${deviceId}`,
  /** WorkspaceView[] */
  workspaces: (deviceId: string) => `sidebar:${deviceId}:workspaces`,
  /** SessionGroups：每个工作区下面的会话标识，已排好序。置顶的、在自定义分区里的各自单列一组 */
  groups: (deviceId: string) => `sidebar:${deviceId}:groups`,
  /** SectionView[]：这台设备上的组（自定义分区），按建的先后，空的也在。一个都没有就是空数组 */
  sections: (deviceId: string) => `sidebar:${deviceId}:sections`,
  /** 这台设备上停下来等人审批或回答的会话。侧栏把会话折起来一部分时，这些不能折掉 */
  pressing: (deviceId: string) => `sidebar:${deviceId}:pressing`,
  /** DeviceActivity：这台设备上的会话合起来的忙闲和最近一次动静。设备列表的一行用它 */
  activity: (deviceId: string) => `sidebar:${deviceId}:activity`,
  /** GroupTallies：每一组里几个在等人、几个在跑、几个未读。侧栏里收起来的工作区、设备那一行用它 */
  tallies: (deviceId: string) => `sidebar:${deviceId}:tallies`,
  /** SessionHarnesses：这台设备上每个会话属于哪个 harness。侧栏只看某个 harness 时按它挑会话 */
  harnessOf: (deviceId: string) => `sidebar:${deviceId}:harnessOf`,
  /**
   * SessionChildren：会话树里每个父会话下面的 Litch 子会话，按派出的先后。只有父会话也在列表里的才算
   * （父会话归档了、删了的子会话照常单列）。groups 里照样有子会话，嵌不嵌由界面按这张表决定
   */
  children: (deviceId: string) => `sidebar:${deviceId}:children`,
  /** ProposalStarts：提案 → 从它开始的子会话（在列表里的） */
  proposalStarts: (deviceId: string) => `sidebar:${deviceId}:proposalStarts`,
  /** SessionSummary */
  summary: (deviceId: string, sessionId: string) => `summary:${deviceId}:${sessionId}`,
  /** SessionSummary[] | null：已归档的会话，最近动过的在前。null 或者没有这个键：还没取过 */
  archived: (deviceId: string) => `sidebar:${deviceId}:archived`,
  /** SessionMeta：有这个键说明会话的快照已经到了 */
  session: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:meta`,
  /** ChannelErrorShape：会话内容没取到。有这个键时界面显示原因和“重试” */
  sessionError: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:error`,
  /** string[]：回合标识，按时间顺序 */
  turnIds: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:turns`,
  /** TurnView */
  turn: (deviceId: string, sessionId: string, turnId: string) =>
    `session:${deviceId}:${sessionId}:turn:${turnId}`,
  /** ItemView */
  item: (deviceId: string, sessionId: string, itemId: string) =>
    `session:${deviceId}:${sessionId}:item:${itemId}`,
  /** RequestView[]：等人答复的请求，按到达顺序 */
  requests: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:requests`,
  /** QueuedMessage[]：排着队还没发的消息 */
  queued: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:queued`,
  /** SessionSettings：下一个回合会用的模型、强度、权限预设 */
  settings: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:settings`,
  usage: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:usage`,
  /** SessionProposalView[]：这个会话上等着用户点的子会话提案 */
  proposals: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:proposals`,
  /**
   * SessionNotes：这个会话收到过的子会话回报，每个子会话留最近的一条（对话里注入的 <litch-session-event>）。
   * 派出子会话的那张卡片上的“最后一句回报”用它
   */
  notes: (deviceId: string, sessionId: string) => `session:${deviceId}:${sessionId}:notes`,
  /** ManageSchema：这台设备上有哪些设置。有这个键说明管理数据的快照已经到了 */
  manage: (deviceId: string) => `manage:${deviceId}:schema`,
  /** SettingsSnapshotView：设置现在的值、待重启的 harness、SSH 入口的状况 */
  manageSnapshot: (deviceId: string) => `manage:${deviceId}:snapshot`,
  /** ManageRevisions：每个设置项的值从打开到现在被动过几次（自己写的、别处写的都算） */
  manageRevisions: (deviceId: string) => `manage:${deviceId}:revisions`,
  /** ChannelErrorShape：管理数据没取到，或者这台设备没有设置接口 */
  manageError: (deviceId: string) => `manage:${deviceId}:error`,
  /** TerminalGroups：每个工作区下面开成标签的终端的标识，按标签的顺序。终端面板的标签栏用它 */
  terminalGroups: (deviceId: string) => `terminals:${deviceId}:groups`,
  /** TerminalGroups：留在设备上、这边没开成标签的终端的标识，同样按工作区分开 */
  terminalStowed: (deviceId: string) => `terminals:${deviceId}:stowed`,
  /** boolean | null：这台设备上新开的终端是不是属于设备的。null：还没连上过，不知道 */
  terminalsDurable: (deviceId: string) => `terminals:${deviceId}:durable`,
  /** TerminalInfo */
  terminal: (deviceId: string, terminalId: string) => `terminals:${deviceId}:info:${terminalId}`,
  /** FileRow[]：一棵文件树（一台设备上的一个根）摊平之后的行。界面只画看得见的那一段 */
  fileRows: fileKeys.rows,
  /** FileTreeState：这棵树的根取到没有、是不是正在刷新。有这个键说明这棵树打开过 */
  fileTree: fileKeys.tree,
  /** boolean：文件树里显不显示隐藏的文件 */
  filesShowHidden: fileKeys.showHidden,
  /** DiffView：一个根在一种范围下变了哪些文件。有这个键说明差异面板正开着它 */
  diff: (deviceId: string, root: string, scope: DiffScope, sessionId: string | null) =>
    `diff:${deviceId}:view:${scope}:${sessionId ?? ''}:${root}`,
  /** boolean | null：这台设备的服务支不支持定时任务。null：还没连上过，不知道 */
  tasksAvailable: (deviceId: string) => `tasks:${deviceId}:available`,
  /** string[]：这台设备上的定时任务的标识，按建的先后 */
  taskIds: (deviceId: string) => `tasks:${deviceId}:ids`,
  /** TaskView */
  task: (deviceId: string, taskId: string) => `tasks:${deviceId}:task:${taskId}`,
  /** number：各台设备上没看过的运行一共有几条。侧栏的“定时任务”入口用它 */
  tasksUnread: 'tasks:unread',
  /** TaskRunsPage：一个任务的运行记录（openTaskRuns 打开着才有） */
  taskRuns: (deviceId: string, taskId: string) => `tasks:${deviceId}:runs:${taskId}`,
  /** ChannelErrorShape：这个根的差异订阅不上（不认识的根之类） */
  diffError: (deviceId: string, root: string, scope: DiffScope, sessionId: string | null) =>
    `diff:${deviceId}:error:${scope}:${sessionId ?? ''}:${root}`,
  /** PairingTopicView：一台设备上已绑定的手机和这台桌面端开出来的配对。openPairing 开着才有 */
  pairing: (deviceId: string) => `pairing:${deviceId}`,
}

/** 一个任务的运行记录（详情页那一列）：新的在前，往下翻页 */
export interface TaskRunsPage {
  runs: TaskRunView[]
  /** 还有更早的就有它；没有了是 null */
  nextCursor: string | null
  /** 正在取（头一页，或者下一页） */
  loading: boolean
  /** 上一次没取到的原因。取到了就清掉 */
  error: ChannelErrorShape | null
}

/** 工作区的标识 → 它下面的终端。不属于任何工作区的（设备主目录的那一组）归在 LOOSE 这个键下 */
export type TerminalGroups = Record<string, string[]>

/** 一台设备上有哪些设置：分组和设置项，顺序就是显示的顺序；另有环境文件里的变量（只读） */
export interface ManageSchema {
  groups: SettingGroupView[]
  settings: SettingSpecView[]
  inheritedEnv: InheritedEnvView[]
}

/**
 * 设置项的键 → 它的值被动过几次。界面给一栏记草稿时记下当时的次数：
 * 之后次数变了，就是这一栏在用户改的过程中被别处动过了。
 */
export type ManageRevisions = Record<string, number>

/** 不属于任何工作区的会话归在这个键下 */
export const LOOSE = ''

/**
 * 置顶的会话归在这个键下。工作区的标识是设备给的（UUID），不会以冒号开头，撞不上。
 * 置顶的、在自定义分区里的会话不再出现在工作区那一组里：一个会话在侧栏里只出现一次
 */
export const PINNED = ':pinned'

/** 一个自定义分区里的会话归在哪个键下 */
export const groupOfSection = (sectionId: string): string => `:section:${sectionId}`

export type SessionGroups = Record<string, string[]>

/**
 * 一台设备上的会话合起来是什么状况。设备列表的一行只订阅这一个键，不去一个个看会话的摘要：
 * 会话可能有几百个，而且折在后面的那些界面根本没有订阅
 */
export interface DeviceActivity {
  /** 有回合在跑的会话有几个 */
  running: number
  /** 停下来等人审批或回答的会话有几个 */
  waiting: number
  /** 最近更新的那个会话是什么时候动的，毫秒时间戳。一个会话都没有就是 null */
  lastActiveAt: number | null
}

/**
 * 一组会话里现在是什么状况。一组收起来的时候里面的行都不画，界面也就没有订阅它们的摘要：
 * 收起的那一行靠这几个数说出“里面有事”。等人的分开记是哪一种，行上要写成和会话行一样的字
 */
export interface GroupTally {
  /** 停下来等审批的 */
  approval: number
  /** 停下来等回答的 */
  answer: number
  /** 有回合在跑的 */
  running: number
  /** 没看过的。它同时在跑或者在等人也算 */
  unread: number
}

/**
 * 分组的键（和 SessionGroups 的一样）→ harness 的标识 → 这一组里这个 harness 的会话的状况。
 * 按 harness 分开记：侧栏只看某个 harness 的时候，汇总也只算看得见的那些。一样都没有的不在里面
 */
export type GroupTallies = Record<string, Record<HarnessId, GroupTally>>

/**
 * 会话的标识 → 它属于哪个 harness。侧栏的分组里只有会话的标识，折在后面的会话界面又没有订阅摘要：
 * 只看某个 harness 时靠这张表挑
 */
export type SessionHarnesses = Record<string, HarnessId>

/** 父会话 → 它下面的 Litch 子会话（按派出的先后） */
export type SessionChildren = Record<string, string[]>

/** 提案 → 从它开始的子会话。对话里那张提案卡片据此显示“已开始”、能跳过去 */
export type ProposalStarts = Record<string, string>

/** 子会话 → 父会话收到的它最近的一条回报 */
export type SessionNotes = Record<string, SessionNoteView>

/** 会话树：父会话也在列表里的子会话，按父会话归拢，组里按派出的先后排 */
function childrenOf(sessions: Map<string, SessionSummary>): SessionChildren {
  const children: SessionChildren = {}
  const sorted = [...sessions.values()]
    .filter((session) => session.lineage && sessions.has(session.lineage.parentId))
    .sort(
      (a, b) => (a.lineage?.createdAt ?? 0) - (b.lineage?.createdAt ?? 0) || (a.id < b.id ? -1 : 1),
    )
  for (const session of sorted) {
    const parent = session.lineage?.parentId
    // 自己挂在自己下面（对面给错了）不算
    if (!parent || parent === session.id) continue
    children[parent] ??= []
    children[parent].push(session.id)
  }
  return children
}

/** 列表里从提案开始的子会话，按提案归拢 */
function startsOf(sessions: Map<string, SessionSummary>): ProposalStarts {
  const starts: ProposalStarts = {}
  for (const session of sessions.values())
    if (session.lineage?.proposalId) starts[session.lineage.proposalId] = session.id
  return starts
}

/** 一批条目里注入的回报，并进已有的那张表：后到的盖掉先到的。没有新的返回原来那张 */
function gatherNotes(before: SessionNotes, items: Iterable<ItemView>): SessionNotes {
  let next = before
  for (const item of items) {
    if (item.kind !== 'userMessage' || !item.event) continue
    for (const note of item.event.notes) {
      if (next === before) next = { ...before }
      next[note.threadId] = note
    }
  }
  return next
}

export interface SessionMeta {
  title: Text
  harness: string
  cwd: string
  /** 能不能在这个会话里发消息 */
  live: boolean
  note: Text | null
  /** 分叉、回退、压缩这几件事对面做不做得了 */
  can: SessionAbilities
  /** 从哪个会话分叉出来的，见 SessionView.forkedFrom */
  forkedFrom: string | null
}

export interface Replica {
  readonly store: KeyedStore
  /** 开始订阅应用和各设备的侧栏。返回停止函数 */
  start(): () => void
  /** 打开一个会话：订阅它的内容。同一个会话可以被打开多次，全部关掉后才退订并清掉内容 */
  openSession(deviceId: string, sessionId: string): () => void
  /** 打开一台设备的管理数据：订阅它的设置。可以打开多次，全部关掉后才退订并清掉 */
  openManage(deviceId: string): () => void
  /** 文件树：展开、收起、刷新。行在状态库里（keys.fileRows） */
  readonly files: FileTrees
  /**
   * 打开一个根的差异概况：订阅它（keys.diff）。核心只在有人订阅的时候才去设备上取，
   * 所以面板不显示的时候要关掉。可以打开多次，全部关掉后才退订并清掉
   */
  openDiff(
    deviceId: string,
    root: string,
    scope: DiffScope,
    sessionId: string | null,
  ): () => void /**
   * 打开一个任务的运行记录：取头一页放进 keys.taskRuns，之后运行的变化跟着改；重连之后重新取头一页。
   * 可以打开多次，全部关掉后才清掉
   */
  openTaskRuns(deviceId: string, taskId: string): () => void
  /** 接着取下一页（没有下一页、正在取的时候不做事） */
  moreTaskRuns(deviceId: string, taskId: string): void
  /**
   * 打开一台设备的扫码绑定情况：订阅它（keys.pairing）。核心在有人订阅时才去取已绑定的手机。
   * 可以打开多次，全部关掉后才退订并清掉
   */
  openPairing(deviceId: string): () => void
  /**
   * 一次运行刚结束（核心连着的时候看着它结束的）：桌面端据此发系统通知。返回取消函数。
   * 对账补上的、断开期间结束的不算
   */
  onTaskRunFinished(listener: (run: TaskRunView, task: TaskView | undefined) => void): () => void
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** 一个会话在侧栏里归哪一组：置顶的、在自定义分区里的各自单列，别的按工作区 */
const groupOf = (session: SessionSummary): string =>
  session.pinned
    ? PINNED
    : session.section
      ? groupOfSection(session.section.id)
      : (session.workspaceId ?? LOOSE)

function groupSessions(sessions: Iterable<SessionSummary>): SessionGroups {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || byId(a, b))
  const groups: SessionGroups = {}
  for (const session of sorted) {
    const key = groupOf(session)
    groups[key] ??= []
    groups[key].push(session.id)
  }
  return groups
}

/**
 * 置顶的和分区里的不按最近动过排：位置要稳，不能因为哪个会话刚说了一句话就跳到前面去。
 * 按放进去的先后排，后放的在后面（协议里“放进分区”不指明位置时就是接在末尾）
 */
function settlePlaced(groups: SessionGroups, sessions: Map<string, SessionSummary>) {
  for (const [key, ids] of Object.entries(groups)) {
    if (!key.startsWith(':')) continue
    const at = (id: string): number => sessions.get(id)?.placedAt ?? 0
    ids.sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0))
  }
}

/**
 * 组的列表：设备给的那一份，按建的先后。会话上带着、列表里还没有的组（别处刚建、列表还没重新取到）接在后面，
 * 名字以最近放进去的那个会话带的为准，免得里面的会话没处画
 */
function sectionsOf(
  listed: readonly SectionView[],
  sessions: Iterable<SessionSummary>,
): SectionView[] {
  const known = new Set(listed.map((entry) => entry.id))
  const found = new Map<string, { section: SectionView; at: number }>()
  for (const session of sessions) {
    if (session.pinned || !session.section || known.has(session.section.id)) continue
    const at = session.placedAt ?? 0
    const seen = found.get(session.section.id)
    if (!seen || at >= seen.at) found.set(session.section.id, { section: session.section, at })
  }
  const extra = [...found.values()].map((entry) => ({
    id: entry.section.id,
    name: entry.section.name,
  }))
  return [...listed, ...extra.sort(byId)]
}

const sameGroups = (a: SessionGroups, b: SessionGroups): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** 各组的状况。只记有事的：闲着的、都看过的不占一项 */
function tallySessions(sessions: Iterable<SessionSummary>): GroupTallies {
  const tallies: GroupTallies = {}
  for (const session of sessions) {
    const waiting = session.status === 'waiting'
    const running = session.status === 'running'
    if (!waiting && !running && !session.unread) continue
    const group = (tallies[groupOf(session)] ??= {})
    const tally = (group[session.harness] ??= { approval: 0, answer: 0, running: 0, unread: 0 })
    if (waiting) tally[session.waitingFor === 'answer' ? 'answer' : 'approval']++
    if (running) tally.running++
    if (session.unread) tally.unread++
  }
  return tallies
}

/** 键的先后不算数：同样的几组、同样的几个 harness、同样的几个数就是没变 */
function sameTallies(a: GroupTallies, b: GroupTallies): boolean {
  const groups = Object.keys(a)
  if (groups.length !== Object.keys(b).length) return false
  return groups.every((group) => {
    const [mine, theirs] = [a[group] ?? {}, b[group]]
    const harnesses = Object.keys(mine)
    if (!theirs || harnesses.length !== Object.keys(theirs).length) return false
    return harnesses.every((harness) => {
      const [one, other] = [mine[harness], theirs[harness]]
      return (
        one !== undefined &&
        other !== undefined &&
        one.approval === other.approval &&
        one.answer === other.answer &&
        one.running === other.running &&
        one.unread === other.unread
      )
    })
  })
}

function sameHarnesses(a: SessionHarnesses, b: SessionHarnesses): boolean {
  const ids = Object.keys(a)
  return ids.length === Object.keys(b).length && ids.every((id) => a[id] === b[id])
}

export function createReplica(channel: CoreChannel): Replica {
  const store = new KeyedStore()
  const sidebars = new Map<string, { stop(): void; sessions: Map<string, SessionSummary> }>()
  /** 各台设备的终端列表的订阅 */
  const terminalLists = new Map<string, () => void>()
  const opened = new Map<string, { count: number; stop(): void }>()
  const managed = new Map<string, { count: number; stop(): void }>()
  const diffs = new Map<string, { count: number; stop(): void }>()
  const pairings = new Map<string, { count: number; stop(): void }>()
  const files = createFileTrees(channel, store)
  /** 各台设备的定时任务的订阅，和每台设备上的任务（算未读合计、找任务名要用） */
  const taskLists = new Map<string, { stop(): void; tasks: Map<string, TaskView> }>()
  /** 打开着的运行记录：键是 keys.taskRuns，记着打开了几次、第几代（重连之后重新取头一页，旧的结果作废） */
  const runPages = new Map<
    string,
    { count: number; deviceId: string; taskId: string; epoch: number }
  >()
  const finishedListeners = new Set<(run: TaskRunView, task: TaskView | undefined) => void>()

  /** 各台设备上没看过的运行加起来。数没变就不换 */
  const refreshTasksUnread = () => {
    let total = 0
    for (const entry of taskLists.values()) {
      for (const task of entry.tasks.values()) total += task.unreadRuns
    }
    if (store.get<number>(keys.tasksUnread) !== total) store.set(keys.tasksUnread, total)
  }

  /** 去取一个任务的运行记录的一页。first：头一页（重来）；否则接着 nextCursor 往下 */
  const loadRuns = (key: string, first: boolean) => {
    const entry = runPages.get(key)
    if (!entry) return
    const page = store.get<TaskRunsPage>(key)
    if (!first && (!page || page.loading || page.nextCursor === null)) return
    if (first) entry.epoch++
    const epoch = entry.epoch
    const cursor = first ? null : (page?.nextCursor ?? null)
    store.set(key, {
      runs: page?.runs ?? [],
      nextCursor: page?.nextCursor ?? null,
      loading: true,
      error: null,
    } satisfies TaskRunsPage)
    channel.command('tasks.runs', { deviceId: entry.deviceId, taskId: entry.taskId, cursor }).then(
      (result) => {
        const now = runPages.get(key)
        if (now !== entry || now.epoch !== epoch) return
        const before = store.get<TaskRunsPage>(key)
        const kept = first ? [] : (before?.runs ?? [])
        const seen = new Set(kept.map((run) => run.id))
        store.set(key, {
          runs: [...kept, ...result.runs.filter((run) => !seen.has(run.id))],
          nextCursor: result.nextCursor,
          loading: false,
          error: null,
        } satisfies TaskRunsPage)
      },
      (error: unknown) => {
        const now = runPages.get(key)
        if (now !== entry || now.epoch !== epoch) return
        const before = store.get<TaskRunsPage>(key)
        store.set(key, {
          runs: before?.runs ?? [],
          nextCursor: before?.nextCursor ?? null,
          loading: false,
          error: toChannelError(error).toShape(),
        } satisfies TaskRunsPage)
      },
    )
  }

  /** 一次运行变了：开着的运行记录里有它就换掉，是新的就放到最前面 */
  const applyRun = (deviceId: string, run: TaskRunView) => {
    const key = keys.taskRuns(deviceId, run.taskId)
    if (!runPages.has(key)) return
    const page = store.get<TaskRunsPage>(key)
    if (!page) return
    const at = page.runs.findIndex((entry) => entry.id === run.id)
    const runs = at < 0 ? [run, ...page.runs] : page.runs.with(at, run)
    store.set(key, { ...page, runs })
  }

  const applyTasks = (deviceId: string, tasks: Map<string, TaskView>, op: TasksOp) => {
    switch (op.op) {
      case 'task.upsert': {
        const had = tasks.has(op.task.id)
        tasks.set(op.task.id, op.task)
        store.set(keys.task(deviceId, op.task.id), op.task)
        if (!had) store.set(keys.taskIds(deviceId), [...tasks.keys()])
        return
      }
      case 'task.remove': {
        if (!tasks.delete(op.taskId)) return
        store.delete(keys.task(deviceId, op.taskId))
        store.set(keys.taskIds(deviceId), [...tasks.keys()])
        return
      }
      case 'run.upsert': {
        applyRun(deviceId, op.run)
        if (op.finished) {
          const task = tasks.get(op.run.taskId)
          for (const listener of [...finishedListeners]) listener(op.run, task)
        }
        return
      }
    }
  }

  const watchTasks = (deviceId: string) => {
    if (taskLists.has(deviceId)) return
    const tasks = new Map<string, TaskView>()
    const stop = channel.subscribe(
      { kind: 'tasks', deviceId },
      {
        snapshot(view: TasksView) {
          store.batch(() => {
            for (const id of tasks.keys()) {
              if (!view.tasks.some((task) => task.id === id)) store.delete(keys.task(deviceId, id))
            }
            tasks.clear()
            for (const task of view.tasks) {
              tasks.set(task.id, task)
              store.set(keys.task(deviceId, task.id), task)
            }
            store.set(keys.taskIds(deviceId), [...tasks.keys()])
            store.set(keys.tasksAvailable(deviceId), view.available)
            refreshTasksUnread()
          })
          // 重新对过账了：开着的运行记录重新取头一页（断开的这段时间里的变化通知没收到）
          for (const [key, entry] of runPages) {
            if (entry.deviceId === deviceId) loadRuns(key, true)
          }
        },
        delta(ops) {
          store.batch(() => {
            for (const op of ops) applyTasks(deviceId, tasks, op)
            refreshTasksUnread()
          })
        },
      },
    )
    taskLists.set(deviceId, { stop, tasks })
  }

  const dropTasks = (deviceId: string) => {
    const entry = taskLists.get(deviceId)
    if (!entry) return
    entry.stop()
    taskLists.delete(deviceId)
    for (const [key, page] of runPages) if (page.deviceId === deviceId) runPages.delete(key)
    store.deletePrefix(`tasks:${deviceId}:`)
    refreshTasksUnread()
  }

  /** 换上一份新的设置值，并把动过的那些键的次数各加一 */
  const setSnapshot = (deviceId: string, snapshot: SettingsSnapshotView, touched: string[]) => {
    store.set(keys.manageSnapshot(deviceId), snapshot)
    const before = store.get<ManageRevisions>(keys.manageRevisions(deviceId))
    if (before && touched.length === 0) return
    const next = { ...before }
    for (const key of touched) next[key] = (next[key] ?? 0) + 1
    store.set(keys.manageRevisions(deviceId), next)
  }

  const applyManage = (deviceId: string, op: ManageOp) => {
    if (op.op === 'settings.set') setSnapshot(deviceId, op.snapshot, op.keys)
  }

  // 只有分组或顺序真的变了才换掉分组这个键，否则一个会话的状态变化会让整个列表重画
  const refreshGroups = (
    deviceId: string,
    sessions: Map<string, SessionSummary>,
    listed: readonly SectionView[],
  ) => {
    const next = groupSessions(sessions.values())
    settlePlaced(next, sessions)
    const prev = store.get<SessionGroups>(keys.groups(deviceId))
    if (!prev || !sameGroups(prev, next)) store.set(keys.groups(deviceId), next)
    const sections = sectionsOf(listed, sessions.values())
    const had = store.get<SectionView[]>(keys.sections(deviceId))
    if (!had || JSON.stringify(had) !== JSON.stringify(sections)) {
      store.set(keys.sections(deviceId), sections)
    }
    const pressing = [...sessions.values()]
      .filter((session) => session.status === 'waiting')
      .map((session) => session.id)
      .sort()
    const before = store.get<string[]>(keys.pressing(deviceId))
    if (!before || before.join('\n') !== pressing.join('\n')) {
      store.set(keys.pressing(deviceId), pressing)
    }
    // 忙闲的汇总也一样：数没变就不换，免得一个会话的标题改了，设备列表的那一行跟着重画
    const activity: DeviceActivity = { running: 0, waiting: pressing.length, lastActiveAt: null }
    for (const session of sessions.values()) {
      if (session.status === 'running') activity.running++
      if (activity.lastActiveAt === null || session.updatedAt > activity.lastActiveAt) {
        activity.lastActiveAt = session.updatedAt
      }
    }
    const was = store.get<DeviceActivity>(keys.activity(deviceId))
    if (
      !was ||
      was.running !== activity.running ||
      was.waiting !== activity.waiting ||
      was.lastActiveAt !== activity.lastActiveAt
    ) {
      store.set(keys.activity(deviceId), activity)
    }
    // 各组的状况同理：数没变就不换，收起的那一行不跟着别的会话的动静重画
    const tallies = tallySessions(sessions.values())
    const tallied = store.get<GroupTallies>(keys.tallies(deviceId))
    if (!tallied || !sameTallies(tallied, tallies)) store.set(keys.tallies(deviceId), tallies)
    // 哪个会话属于哪个 harness：会话多了、少了才换（一个会话不会换 harness）
    const harnessOf: SessionHarnesses = {}
    for (const session of sessions.values()) harnessOf[session.id] = session.harness
    const known = store.get<SessionHarnesses>(keys.harnessOf(deviceId))
    if (!known || !sameHarnesses(known, harnessOf)) store.set(keys.harnessOf(deviceId), harnessOf)
    // 会话树：父子关系变了、会话多了少了才换
    const children = childrenOf(sessions)
    const nested = store.get<SessionChildren>(keys.children(deviceId))
    if (!nested || JSON.stringify(nested) !== JSON.stringify(children)) {
      store.set(keys.children(deviceId), children)
    }
    const starts = startsOf(sessions)
    const started = store.get<ProposalStarts>(keys.proposalStarts(deviceId))
    if (!started || JSON.stringify(started) !== JSON.stringify(starts)) {
      store.set(keys.proposalStarts(deviceId), starts)
    }
  }

  const applySidebar = (deviceId: string, sessions: Map<string, SessionSummary>, op: SidebarOp) => {
    switch (op.op) {
      case 'session.upsert':
        sessions.set(op.session.id, op.session)
        store.set(keys.summary(deviceId, op.session.id), op.session)
        return
      case 'session.remove':
        sessions.delete(op.sessionId)
        store.delete(keys.summary(deviceId, op.sessionId))
        return
      case 'archived.set':
        store.set(keys.archived(deviceId), op.sessions)
        return
      case 'workspace.upsert': {
        const list = store.get<SidebarView['workspaces']>(keys.workspaces(deviceId)) ?? []
        const index = list.findIndex((workspace) => workspace.id === op.workspace.id)
        const next = index < 0 ? [...list, op.workspace] : list.with(index, op.workspace)
        store.set(keys.workspaces(deviceId), next)
        return
      }
      case 'workspace.remove': {
        const list = store.get<SidebarView['workspaces']>(keys.workspaces(deviceId)) ?? []
        store.set(
          keys.workspaces(deviceId),
          list.filter((workspace) => workspace.id !== op.workspaceId),
        )
        return
      }
    }
  }

  const watchSidebar = (deviceId: string) => {
    if (sidebars.has(deviceId)) return
    const sessions = new Map<string, SessionSummary>()
    /** 设备给的组的列表，跟着侧栏的快照换 */
    let listed: readonly SectionView[] = []
    const stop = channel.subscribe(
      { kind: 'sidebar', deviceId },
      {
        snapshot(view: SidebarView) {
          store.batch(() => {
            for (const id of sessions.keys()) store.delete(keys.summary(deviceId, id))
            sessions.clear()
            store.set(keys.workspaces(deviceId), view.workspaces)
            listed = view.sections
            store.set(keys.archived(deviceId), view.archived)
            for (const session of view.sessions) {
              sessions.set(session.id, session)
              store.set(keys.summary(deviceId, session.id), session)
            }
            refreshGroups(deviceId, sessions, listed)
          })
        },
        delta(ops) {
          store.batch(() => {
            for (const op of ops) applySidebar(deviceId, sessions, op)
            refreshGroups(deviceId, sessions, listed)
          })
        },
      },
    )
    sidebars.set(deviceId, { stop, sessions })
  }

  const dropSidebar = (deviceId: string) => {
    const entry = sidebars.get(deviceId)
    if (!entry) return
    entry.stop()
    sidebars.delete(deviceId)
    store.deletePrefix(`sidebar:${deviceId}:`)
    store.deletePrefix(`summary:${deviceId}:`)
    terminalLists.get(deviceId)?.()
    terminalLists.delete(deviceId)
    store.deletePrefix(`terminals:${deviceId}:`)
    dropTasks(deviceId)
  }

  /** 终端的列表：每个终端一个键，另有“每个工作区下有哪些标签”和“留在设备上的有哪些”两个汇总 */
  const watchTerminals = (deviceId: string) => {
    if (terminalLists.has(deviceId)) return
    const infos = new Map<string, TerminalInfo>()
    // 只有分组或顺序真的变了才换掉汇总的键：一个终端的状态变化不该让整条标签栏重画
    const refresh = () => {
      const sorted = [...infos.values()].sort(
        (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      const groups: TerminalGroups = {}
      const stowed: TerminalGroups = {}
      for (const info of sorted) {
        const into = info.shown ? groups : stowed
        const key = info.workspaceId ?? LOOSE
        into[key] ??= []
        into[key].push(info.id)
      }
      for (const [key, next] of [
        [keys.terminalGroups(deviceId), groups],
        [keys.terminalStowed(deviceId), stowed],
      ] as const) {
        const before = store.get<TerminalGroups>(key)
        if (!before || JSON.stringify(before) !== JSON.stringify(next)) store.set(key, next)
      }
    }
    const apply = (op: TerminalsOp) => {
      if (op.op === 'terminal.upsert') {
        infos.set(op.terminal.id, op.terminal)
        store.set(keys.terminal(deviceId, op.terminal.id), op.terminal)
      } else if (op.op === 'terminal.remove') {
        infos.delete(op.terminalId)
        store.delete(keys.terminal(deviceId, op.terminalId))
      } else store.set(keys.terminalsDurable(deviceId), op.durable)
    }
    const stop = channel.subscribe(
      { kind: 'terminals', deviceId },
      {
        snapshot(view: TerminalsView) {
          store.batch(() => {
            for (const id of infos.keys()) store.delete(keys.terminal(deviceId, id))
            infos.clear()
            store.set(keys.terminalsDurable(deviceId), view.durable)
            for (const terminal of view.terminals) apply({ op: 'terminal.upsert', terminal })
            refresh()
          })
        },
        delta(ops) {
          store.batch(() => {
            for (const op of ops) apply(op)
            refresh()
          })
        },
      },
    )
    terminalLists.set(deviceId, stop)
  }

  const applyApp = (op: AppOp) => {
    const ids = store.get<string[]>(keys.devices) ?? []
    if (op.op === 'device.upsert') {
      const before = store.get<DeviceView>(keys.device(op.device.id))
      store.set(keys.device(op.device.id), op.device)
      if (!ids.includes(op.device.id)) store.set(keys.devices, [...ids, op.device.id])
      watchSidebar(op.device.id)
      watchTerminals(op.device.id)
      watchTasks(op.device.id)
      // 断了又连上：正看着的文件树重新对一遍（断着的时候取的都是“没连上”）
      if (before && before.connection !== 'online' && op.device.connection === 'online') {
        files.reconnected(op.device.id)
      }
    } else {
      store.delete(keys.device(op.deviceId))
      store.set(
        keys.devices,
        ids.filter((id) => id !== op.deviceId),
      )
      dropSidebar(op.deviceId)
      files.drop(op.deviceId)
    }
  }

  const applySession = (deviceId: string, sessionId: string, op: SessionOp) => {
    const itemKey = (itemId: string) => keys.item(deviceId, sessionId, itemId)
    const turnKey = (turnId: string) => keys.turn(deviceId, sessionId, turnId)
    switch (op.op) {
      case 'turn.add': {
        const ids = store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []
        store.set(turnKey(op.turn.id), op.turn)
        if (!ids.includes(op.turn.id))
          store.set(keys.turnIds(deviceId, sessionId), [...ids, op.turn.id])
        return
      }
      case 'turn.remove': {
        const turn = store.get<TurnView>(turnKey(op.turnId))
        if (!turn) return
        const ids = store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []
        store.set(
          keys.turnIds(deviceId, sessionId),
          ids.filter((id) => id !== op.turnId),
        )
        store.delete(turnKey(op.turnId))
        for (const itemId of turn.itemIds) store.delete(itemKey(itemId))
        return
      }
      case 'turn.status': {
        const turn = store.get<TurnView>(turnKey(op.turnId))
        if (turn)
          store.set(turnKey(op.turnId), {
            ...turn,
            status: op.status,
            durationMs: op.durationMs,
            ...(op.error === undefined ? {} : { error: op.error }),
          })
        return
      }
      case 'item.add': {
        store.set(itemKey(op.item.id), op.item)
        if (op.item.kind === 'userMessage' && op.item.event) {
          const before = store.get<SessionNotes>(keys.notes(deviceId, sessionId)) ?? {}
          store.set(keys.notes(deviceId, sessionId), gatherNotes(before, [op.item]))
        }
        const turn = store.get<TurnView>(turnKey(op.turnId))
        if (turn && !turn.itemIds.includes(op.item.id)) {
          store.set(turnKey(op.turnId), { ...turn, itemIds: [...turn.itemIds, op.item.id] })
        }
        return
      }
      case 'item.appendText': {
        const item = store.get<ItemView>(itemKey(op.itemId))
        if (!item) return
        if (op.field === 'output' && item.kind === 'command') {
          // 和核心的视图同一个函数：输出有上限，太长的只留头尾（text/output-cap.mts）
          store.set(itemKey(op.itemId), { ...item, ...appendOutput(item, op.text) })
        } else if (
          op.field === 'text' &&
          (item.kind === 'agentMessage' || item.kind === 'reasoning' || item.kind === 'plan')
        ) {
          store.set(itemKey(op.itemId), { ...item, text: item.text + op.text })
        }
        return
      }
      case 'item.appendOutput': {
        // 通道把一帧里很长的输出只发了头尾（channel/server.mts）：接出来和核心手里整段接的一样
        const item = store.get<ItemView>(itemKey(op.itemId))
        if (item?.kind === 'command') {
          store.set(itemKey(op.itemId), { ...item, ...appendSkipping(item, op) })
        }
        return
      }
      case 'item.remove': {
        const turn = store.get<TurnView>(turnKey(op.turnId))
        if (turn) {
          store.set(turnKey(op.turnId), {
            ...turn,
            itemIds: turn.itemIds.filter((id) => id !== op.itemId),
          })
        }
        store.delete(itemKey(op.itemId))
        return
      }
      case 'item.status': {
        const item = store.get<ItemView>(itemKey(op.itemId))
        // 有些条目没有状态（用户消息、计划、一行说明）
        if (item && 'status' in item) store.set(itemKey(op.itemId), { ...item, status: op.status })
        return
      }
      case 'request.add': {
        const list = store.get<RequestView[]>(keys.requests(deviceId, sessionId)) ?? []
        if (!list.some((request) => request.id === op.request.id))
          store.set(keys.requests(deviceId, sessionId), [...list, op.request])
        return
      }
      case 'request.remove': {
        const list = store.get<RequestView[]>(keys.requests(deviceId, sessionId)) ?? []
        store.set(
          keys.requests(deviceId, sessionId),
          list.filter((request) => request.id !== op.requestId),
        )
        return
      }
      case 'queue.set':
        store.set(keys.queued(deviceId, sessionId), op.queued satisfies QueuedMessage[])
        return
      case 'session.state': {
        const meta = store.get<SessionMeta>(keys.session(deviceId, sessionId))
        if (meta)
          store.set(keys.session(deviceId, sessionId), { ...meta, live: op.live, note: op.note })
        return
      }
      case 'session.settings':
        store.set(keys.settings(deviceId, sessionId), op.settings satisfies SessionSettings)
        return
      case 'session.usage':
        store.set(keys.usage(deviceId, sessionId), op.usage)
        return
      case 'session.can': {
        const meta = store.get<SessionMeta>(keys.session(deviceId, sessionId))
        if (meta) store.set(keys.session(deviceId, sessionId), { ...meta, can: op.can })
        return
      }
      case 'session.proposals':
        store.set(keys.proposals(deviceId, sessionId), op.proposals satisfies SessionProposalView[])
        return
    }
  }

  return {
    store,

    start() {
      const stopApp = channel.subscribe(
        { kind: 'app' },
        {
          snapshot(view: AppView) {
            store.batch(() => {
              const next = new Set(view.devices.map((device) => device.id))
              for (const id of store.get<string[]>(keys.devices) ?? []) {
                if (!next.has(id)) applyApp({ op: 'device.remove', deviceId: id })
              }
              store.set(keys.devices, [])
              for (const device of view.devices) applyApp({ op: 'device.upsert', device })
            })
          },
          delta(ops) {
            store.batch(() => {
              for (const op of ops) applyApp(op)
            })
          },
        },
      )
      return () => {
        stopApp()
        for (const deviceId of [...sidebars.keys()]) dropSidebar(deviceId)
      }
    },

    openManage(deviceId) {
      const existing = managed.get(deviceId)
      if (existing) {
        existing.count++
      } else {
        const stop = channel.subscribe(
          { kind: 'manage', deviceId },
          {
            snapshot(view: ManageView) {
              store.batch(() => {
                store.delete(keys.manageError(deviceId))
                // 重连之后重新读到的：和手上那份不一样的键，算被动过
                const before = store.get<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
                setSnapshot(
                  deviceId,
                  view.snapshot,
                  before ? changedKeys(before, view.snapshot) : [],
                )
                const schema: ManageSchema = {
                  groups: view.groups,
                  settings: view.settings,
                  inheritedEnv: view.inheritedEnv,
                }
                store.set(keys.manage(deviceId), schema)
              })
            },
            delta(ops) {
              store.batch(() => {
                for (const op of ops) applyManage(deviceId, op)
              })
            },
            error(error) {
              // 订阅到此结束。界面要重试的话，关掉再打开
              store.set(keys.manageError(deviceId), error.toShape() satisfies ChannelErrorShape)
            },
          },
        )
        managed.set(deviceId, { count: 1, stop })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = managed.get(deviceId)
        if (!entry) return
        entry.count--
        if (entry.count > 0) return
        entry.stop()
        managed.delete(deviceId)
        store.deletePrefix(`manage:${deviceId}:`)
      }
    },

    openSession(deviceId, sessionId) {
      const key = `${deviceId}:${sessionId}`
      const existing = opened.get(key)
      if (existing) {
        existing.count++
      } else {
        const stop = channel.subscribe(
          { kind: 'session', deviceId, sessionId },
          {
            snapshot(view: SessionView) {
              store.batch(() => {
                store.deletePrefix(`session:${deviceId}:${sessionId}:`)
                for (const item of Object.values(view.items)) {
                  store.set(keys.item(deviceId, sessionId, item.id), item)
                }
                for (const turn of view.turns)
                  store.set(keys.turn(deviceId, sessionId, turn.id), turn)
                store.set(
                  keys.turnIds(deviceId, sessionId),
                  view.turns.map((turn) => turn.id),
                )
                store.set(keys.requests(deviceId, sessionId), view.requests)
                store.set(keys.queued(deviceId, sessionId), view.queued)
                store.set(keys.settings(deviceId, sessionId), view.settings)
                store.set(keys.usage(deviceId, sessionId), view.usage)
                store.set(keys.proposals(deviceId, sessionId), view.proposals)
                // 按回合、条目的先后：同一个子会话后来的回报盖掉先前的
                const ordered = view.turns.flatMap((turn) =>
                  turn.itemIds.flatMap((id) => view.items[id] ?? []),
                )
                store.set(keys.notes(deviceId, sessionId), gatherNotes({}, ordered))
                const meta: SessionMeta = {
                  title: view.title,
                  harness: view.harness,
                  cwd: view.cwd,
                  live: view.live,
                  note: view.note,
                  can: view.can,
                  forkedFrom: view.forkedFrom,
                }
                store.set(keys.session(deviceId, sessionId), meta)
              })
            },
            delta(ops) {
              store.batch(() => {
                for (const op of ops) applySession(deviceId, sessionId, op)
              })
            },
            error(error) {
              // 订阅到此结束。界面要重试的话，把这个会话关掉再打开
              store.set(keys.sessionError(deviceId, sessionId), error.toShape())
            },
          },
        )
        opened.set(key, { count: 1, stop })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = opened.get(key)
        if (!entry) return
        entry.count--
        if (entry.count > 0) return
        entry.stop()
        opened.delete(key)
        store.deletePrefix(`session:${deviceId}:${sessionId}:`)
      }
    },

    files,

    openTaskRuns(deviceId, taskId) {
      const key = keys.taskRuns(deviceId, taskId)
      const existing = runPages.get(key)
      if (existing) existing.count++
      else {
        runPages.set(key, { count: 1, deviceId, taskId, epoch: 0 })
        loadRuns(key, true)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = runPages.get(key)
        if (!entry) return
        entry.count--
        if (entry.count > 0) return
        runPages.delete(key)
        store.delete(key)
      }
    },

    moreTaskRuns(deviceId, taskId) {
      loadRuns(keys.taskRuns(deviceId, taskId), false)
    },

    onTaskRunFinished(listener) {
      finishedListeners.add(listener)
      return () => {
        finishedListeners.delete(listener)
      }
    },

    openPairing(deviceId) {
      const key = keys.pairing(deviceId)
      const existing = pairings.get(key)
      if (existing) {
        existing.count++
      } else {
        const stop = channel.subscribe(
          { kind: 'pairing', deviceId },
          {
            snapshot(view: PairingTopicView) {
              store.set(key, view)
            },
            delta(ops) {
              const was = store.get<PairingTopicView>(key)
              if (!was) return
              let next = was
              for (const op of ops) {
                if (op.op === 'phones.set') next = { ...next, phones: op.phones }
                else {
                  const others = next.pairs.filter((pair) => pair.pairId !== op.status.pairId)
                  next = { ...next, pairs: [...others, op.status] }
                }
              }
              store.set(key, next)
            },
          },
        )
        pairings.set(key, { count: 1, stop })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = pairings.get(key)
        if (!entry) return
        entry.count--
        if (entry.count > 0) return
        entry.stop()
        pairings.delete(key)
        store.delete(key)
      }
    },

    openDiff(deviceId, root, scope, sessionId) {
      const key = keys.diff(deviceId, root, scope, sessionId)
      const errorKey = keys.diffError(deviceId, root, scope, sessionId)
      const existing = diffs.get(key)
      if (existing) {
        existing.count++
      } else {
        const stop = channel.subscribe(
          { kind: 'diff', deviceId, root, scope, sessionId },
          {
            snapshot(view: DiffView) {
              store.set(key, view)
            },
            delta(ops) {
              for (const op of ops) store.set(key, op.view)
            },
            error(error) {
              store.set(errorKey, error.toShape() satisfies ChannelErrorShape)
            },
          },
        )
        diffs.set(key, { count: 1, stop })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = diffs.get(key)
        if (!entry) return
        entry.count--
        if (entry.count > 0) return
        entry.stop()
        diffs.delete(key)
        store.batch(() => {
          store.delete(key)
          store.delete(errorKey)
        })
      }
    },
  }
}
