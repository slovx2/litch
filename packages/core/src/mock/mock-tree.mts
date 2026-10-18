// 模拟核心里的会话树：设备进程那一头（Litch 子会话、提案、回报与唤醒）和引擎自己的子代理线程，
// 都在这里假装出来，界面开发不等设备进程。会话树的规矩照 protocol/extensions/session-tree.json：
// - 对话里说“派子会话”（英文 spawn sub-sessions）：模型调两次 litch_sessions.start，派出两个子会话
//   （一个在 Pi 上，一个和父会话同一个 harness），父会话回一句就停下；子会话各自跑完一回合，
//   都停下之后替父会话开一个唤醒回合（<litch-session-event kind="wake">）；
// - 说“提个子会话”（propose a sub-session）：模型提两个提案，第二个过一会儿就过期收掉，点“开始”才起；
// - 说“用子代理”（use sub-agents）：引擎自己派两个子代理线程（不进侧栏），一个能直接输入、一个不能，
//   它们回来之后父会话才接着说；
// - 界面上手动派（session.spawn）、脱离（session.detach）、提案的开始和不要、列子代理（session.agents）。
// 子会话的回报没被唤醒带走的，攒到父会话下一条用户消息前面（kind="notes"）。
import { CLIENT_TOOL_NAMESPACE, SESSION_TREE_LIMITS } from '../../../protocol/src/index.mjs'
import { ChannelError, type Commands, type SessionOp } from '../channel/protocol.mjs'
import type {
  HarnessView,
  OutgoingMessage,
  SessionAbilities,
  SessionSettings,
  SessionSummary,
  SessionView,
} from '../model.mjs'
import type {
  AgentThreadView,
  LineageKind,
  LineageOrigin,
  SessionEventView,
  SessionNoteView,
  SessionProposalView,
} from '../model-tree.mjs'
import { phrase } from '../phrase.mjs'
import { projectItem } from '../projection/items.mjs'
import { outgoing } from '../projection/outgoing.mjs'
import type { SampleLang } from './sample-text.mjs'
import { TREE_TEXT, type TreeAgent } from './sample-tree.mjs'

const SPAWNS = /派子会话|spawn sub-sessions/i
const PROPOSES = /提个子会话|propose a sub-session/i
const USES_AGENTS = /用子代理|use sub-agents/i

/** 第二个提案多久过期（按模拟的时钟）。真的是 7 天，这里要来得及看它收掉 */
const SHORT_PROPOSAL_MS = 8000

export interface MockTreeHost {
  lang: SampleLang
  now(): number
  setTimer(run: () => void, ms: number): () => void
  /** 侧栏里的一个会话。没有是 undefined */
  summary(deviceId: string, sessionId: string): SessionSummary | undefined
  /** 这台设备侧栏里所有的会话 */
  summaries(deviceId: string): SessionSummary[]
  /** 往侧栏里加一个会话并告诉订阅者 */
  addSummary(deviceId: string, summary: SessionSummary): void
  updateSummary(deviceId: string, sessionId: string, patch: Partial<SessionSummary>): void
  /** 载入（或者拿已经载入的）一个会话的内容 */
  view(deviceId: string, sessionId: string): SessionView
  /** 放进一个新会话的内容 */
  putView(view: SessionView): void
  apply(view: SessionView, ops: SessionOp[]): void
  /** 开一个回合：发一条消息（event 是注入在它开头的那一段）。返回回合的标识 */
  startTurn(view: SessionView, message: OutgoingMessage, event?: SessionEventView): string
  /** 在回合里流出一段回答，流完回合结束 */
  reply(view: SessionView, turnId: string, text: string): void
  running(view: SessionView): boolean
  /** 这台设备有没有会话树（DeviceView.sessionTree） */
  treeOn(deviceId: string): boolean
  harnesses(deviceId: string): HarnessView[]
  settings(deviceId: string, harness: string): SessionSettings
  can(deviceId: string, harness: string): SessionAbilities
  nextId(prefix: string): string
}

interface AgentEntry {
  deviceId: string
  parentId: string
  /** 派出它的那个子代理调用：父会话的哪个回合、哪个条目 */
  turnId: string
  itemId: string
  spec: TreeAgent
  view: SessionView
  done: boolean
}

export interface MockTree {
  /** 这条消息是不是会话树的一出：是的话由这里接着演，返回 true */
  claim(view: SessionView, turnId: string, message: OutgoingMessage): boolean
  /** 一个回合结束了：子会话的话记一条回报，看要不要唤醒父会话；子代理的话看父会话能不能接着说 */
  ended(view: SessionView, status: 'completed' | 'interrupted' | 'failed'): void
  /** 用户发的一条消息：攒着的回报附在它前面，唤醒的次数从头算 */
  notesFor(view: SessionView): SessionEventView | undefined
  /** 引擎自己的子代理线程的内容。不是子代理是 undefined */
  agentView(deviceId: string, sessionId: string): SessionView | undefined
  command(name: string, params: unknown): unknown
}

const sameKey = (deviceId: string, sessionId: string): string => `${deviceId}:${sessionId}`

export function createMockTree(host: MockTreeHost): MockTree {
  const text = TREE_TEXT[host.lang]
  /** 父会话 → 攒着的回报（同一个子会话后来的盖掉先前的） */
  const pending = new Map<string, SessionNoteView[]>()
  /** 父会话 → 上一条用户消息之后唤醒了几次 */
  const wakes = new Map<string, number>()
  /** 子会话 → 它要回的话（演示里写好的）。没有的照模拟核心平常那样回 */
  const scripted = new Map<string, string>()
  /** 引擎自己的子代理线程 */
  const agents = new Map<string, AgentEntry>()

  const deviceHarness = (deviceId: string, wanted: string | null, fallback: string): string => {
    const ready = host.harnesses(deviceId).filter((entry) => entry.state === 'ready')
    if (wanted && ready.some((entry) => entry.id === wanted)) return wanted
    return fallback
  }

  /** 父会话是谁、标题是什么，写进子会话的第一段话 */
  const briefOf = (parent: SessionView, prompt: string): string => {
    const title = host.summary(parent.deviceId, parent.sessionId)?.title ?? parent.title
    const name = typeof title === 'string' ? title : parent.sessionId
    return `${text.briefHead.replace('{parent}', name)}\n\n${prompt}`
  }

  /** 起一个子会话：放进侧栏（带着父子关系），发第一段话 */
  const startChild = (
    parent: SessionView,
    options: {
      title: string
      prompt: string
      harness: string | null
      kind: LineageKind
      origin: LineageOrigin
      wakeParent: boolean
      reply: string | null
      settings?: Partial<SessionSettings>
      workspaceId?: string
      cwd?: string
    },
  ): string => {
    const { deviceId } = parent
    const harness = deviceHarness(deviceId, options.harness, parent.harness)
    if (options.kind === 'fork' && harness !== parent.harness) {
      throw new ChannelError('rejected', '带着上下文派出的子会话只能和父会话同一个 harness')
    }
    const live = host
      .summaries(deviceId)
      .filter(
        (entry) =>
          entry.lineage?.parentId === parent.sessionId &&
          (entry.status === 'running' || entry.status === 'waiting'),
      )
    if (live.length >= SESSION_TREE_LIMITS.liveChildren) {
      throw new ChannelError('rejected', '这个会话同时在跑的子会话太多了')
    }
    const parentSummary = host.summary(deviceId, parent.sessionId)
    const now = host.now()
    const summary: SessionSummary = {
      id: host.nextId('c'),
      workspaceId: options.workspaceId ?? parentSummary?.workspaceId ?? null,
      harness,
      title: options.title,
      status: 'idle',
      waitingFor: null,
      unread: false,
      updatedAt: now,
      cwd: options.cwd ?? parent.cwd,
      pinned: false,
      section: null,
      placedAt: null,
      task: null,
      lineage: {
        parentId: parent.sessionId,
        kind: options.kind,
        origin: options.origin,
        title: options.title,
        wakeParent: options.wakeParent,
        createdAt: now,
      },
    }
    host.addSummary(deviceId, summary)
    // fork：带着父会话到现在为止的全部内容
    const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const view: SessionView = {
      deviceId,
      sessionId: summary.id,
      title: summary.title,
      harness,
      cwd: summary.cwd,
      live: true,
      note: null,
      turns: options.kind === 'fork' ? copy(parent.turns) : [],
      items: options.kind === 'fork' ? copy(parent.items) : {},
      requests: [],
      queued: [],
      settings: { ...host.settings(deviceId, harness), ...options.settings },
      usage: null,
      can: host.can(deviceId, harness),
      forkedFrom: null,
      proposals: [],
    }
    host.putView(view)
    if (options.reply) scripted.set(sameKey(deviceId, summary.id), options.reply)
    host.startTurn(view, outgoing(briefOf(parent, options.prompt)))
    return summary.id
  }

  /** 模型调了一次 litch_sessions.start：对话里那一条工具调用（经真的投影，界面画成派出卡片） */
  const startCall = (
    turnId: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): SessionOp => ({
    op: 'item.add',
    turnId,
    item: projectItem({
      type: 'dynamicToolCall',
      id: host.nextId('ls'),
      namespace: CLIENT_TOOL_NAMESPACE.sessions,
      tool: 'start',
      arguments: args,
      status: 'completed',
      contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
      success: true,
      durationMs: 40,
    } as never),
  })

  const spawnDemo = (view: SessionView, turnId: string) => {
    const ops: SessionOp[] = []
    text.children.forEach((child, index) => {
      // 第一个放在 Pi 上（跨 harness 只能 fresh），第二个和父会话同一个 harness
      const harness = index === 0 ? 'pi' : view.harness
      const threadId = startChild(view, {
        title: child.title,
        prompt: child.prompt,
        harness,
        kind: 'fresh',
        origin: 'model',
        wakeParent: true,
        reply: child.reply,
      })
      ops.push(
        startCall(
          turnId,
          {
            title: child.title,
            prompt: child.prompt,
            harness,
            initiation: 'user_asked',
          },
          { thread_id: threadId, note: 'Started.' },
        ),
      )
    })
    host.apply(view, ops)
    host.reply(view, turnId, text.spawnReply)
  }

  const proposalsOf = (view: SessionView): SessionProposalView[] => view.proposals

  const setProposals = (view: SessionView, proposals: SessionProposalView[]) =>
    host.apply(view, [{ op: 'session.proposals', proposals }])

  const proposeDemo = (view: SessionView, turnId: string) => {
    const now = host.now()
    const made = text.proposals.map(
      (proposal, index): SessionProposalView => ({
        id: host.nextId('pr'),
        title: proposal.title,
        prompt: proposal.prompt,
        harness: null,
        model: null,
        kind: 'fresh',
        wakeParent: true,
        createdAt: now + index,
        expiresAt:
          index === 0
            ? now + SESSION_TREE_LIMITS.proposalTtlSeconds * 1000
            : now + SHORT_PROPOSAL_MS,
      }),
    )
    for (const [index, proposal] of made.entries()) {
      const sample = text.proposals[index]
      if (sample) scripted.set(`proposal:${proposal.id}`, sample.reply)
    }
    host.apply(view, [
      ...made.map((proposal) =>
        startCall(
          turnId,
          { title: proposal.title, prompt: proposal.prompt, initiation: 'propose' },
          { proposal_id: proposal.id, note: 'Proposed; waiting for the user.' },
        ),
      ),
      { op: 'session.proposals', proposals: [...proposalsOf(view), ...made] },
    ])
    // 和设备进程一样：过期的那一刻发一次通知，界面上的卡片收掉
    for (const proposal of made) {
      host.setTimer(() => {
        if (!view.proposals.some((entry) => entry.id === proposal.id)) return
        setProposals(
          view,
          view.proposals.filter((entry) => entry.id !== proposal.id),
        )
      }, proposal.expiresAt - now)
    }
    host.reply(view, turnId, text.proposeReply)
  }

  /** 子代理调用的条目：经真的投影，界面画成能点开的卡片 */
  const collabItem = (
    id: string,
    tool: 'spawnAgent' | 'wait',
    status: 'inProgress' | 'completed',
    entries: AgentEntry[],
    parentId: string,
  ) =>
    projectItem({
      type: 'collabAgentToolCall',
      id,
      tool,
      status,
      senderThreadId: parentId,
      receiverThreadIds: entries.map((entry) => entry.view.sessionId),
      prompt: tool === 'spawnAgent' ? text.agentsPrompt : null,
      model: null,
      reasoningEffort: null,
      agentsStates: Object.fromEntries(
        entries.map((entry) => [
          entry.view.sessionId,
          {
            status: entry.done ? 'completed' : 'running',
            message: entry.done ? entry.spec.reply : null,
          },
        ]),
      ),
    } as never)

  const agentsDemo = (view: SessionView, turnId: string) => {
    const itemId = host.nextId('ca')
    const made: AgentEntry[] = text.agents.map((spec) => {
      const id = host.nextId('ag')
      const agent: SessionView = {
        deviceId: view.deviceId,
        sessionId: id,
        title: spec.nickname,
        harness: view.harness,
        cwd: view.cwd,
        // 不接受直接输入的子代理只能看（真的核心照 canAcceptDirectInput 这样投影）
        live: spec.canInput,
        note: spec.canInput ? null : phrase('session.agentReadOnly'),
        turns: [],
        items: {},
        requests: [],
        queued: [],
        settings: host.settings(view.deviceId, view.harness),
        usage: null,
        can: host.can(view.deviceId, view.harness),
        forkedFrom: null,
        proposals: [],
      }
      const entry: AgentEntry = {
        deviceId: view.deviceId,
        parentId: view.sessionId,
        turnId,
        itemId,
        spec,
        view: agent,
        done: false,
      }
      agents.set(sameKey(view.deviceId, id), entry)
      host.putView(agent)
      return entry
    })
    host.apply(view, [
      {
        op: 'item.add',
        turnId,
        item: collabItem(itemId, 'spawnAgent', 'inProgress', made, view.sessionId),
      },
    ])
    for (const entry of made) {
      scripted.set(sameKey(entry.deviceId, entry.view.sessionId), entry.spec.reply)
      host.startTurn(entry.view, outgoing(entry.spec.prompt))
    }
  }

  /** 父会话的一个子代理回来了：更新那张卡片；都回来了，父会话接着说 */
  const agentDone = (entry: AgentEntry) => {
    entry.done = true
    const siblings = [...agents.values()].filter(
      (other) => other.itemId === entry.itemId && other.deviceId === entry.deviceId,
    )
    const parent = host.view(entry.deviceId, entry.parentId)
    const allDone = siblings.every((other) => other.done)
    const ops: SessionOp[] = [
      {
        op: 'item.add',
        turnId: entry.turnId,
        item: collabItem(
          entry.itemId,
          'spawnAgent',
          allDone ? 'completed' : 'inProgress',
          siblings,
          entry.parentId,
        ),
      },
    ]
    if (allDone) {
      ops.push({
        op: 'item.add',
        turnId: entry.turnId,
        item: collabItem(host.nextId('cw'), 'wait', 'completed', siblings, entry.parentId),
      })
    }
    host.apply(parent, ops)
    if (
      allDone &&
      parent.turns.some((turn) => turn.id === entry.turnId && turn.status === 'running')
    )
      host.reply(parent, entry.turnId, text.agentsReply)
  }

  /** 父会话的直接子会话都停下了吗 */
  const childrenStopped = (deviceId: string, parentId: string): boolean =>
    host
      .summaries(deviceId)
      .filter((entry) => entry.lineage?.parentId === parentId)
      .every((entry) => entry.status !== 'running' && entry.status !== 'waiting')

  /** 唤醒的条件都满足了就替父会话开一个回合（决 271） */
  const tryWake = (deviceId: string, parentId: string) => {
    const key = sameKey(deviceId, parentId)
    const notes = pending.get(key) ?? []
    if (notes.length === 0) return
    if (!host.summary(deviceId, parentId)) return
    const parent = host.view(deviceId, parentId)
    if (host.running(parent) || parent.requests.length > 0) return
    if (!childrenStopped(deviceId, parentId)) return
    const wanted = host
      .summaries(deviceId)
      .some(
        (entry) =>
          entry.lineage?.parentId === parentId &&
          entry.lineage.wakeParent &&
          notes.some((note) => note.threadId === entry.id),
      )
    if (!wanted) return
    const count = wakes.get(key) ?? 0
    if (count >= SESSION_TREE_LIMITS.wakesPerUserMessage) return
    wakes.set(key, count + 1)
    pending.delete(key)
    // 唤醒的回合只有注入的那一段，没有用户自己的话（不过 outgoing 的空消息检查）
    host.startTurn(parent, { text: '', images: [], extras: [] }, { kind: 'wake', notes })
  }

  return {
    claim(view, turnId, message) {
      const key = sameKey(view.deviceId, view.sessionId)
      const user = view.items[view.turns.find((turn) => turn.id === turnId)?.itemIds[0] ?? '']
      if (user?.kind === 'userMessage' && user.event?.kind === 'wake') {
        host.reply(view, turnId, text.wakeReply)
        return true
      }
      const script = scripted.get(key)
      if (script !== undefined) {
        scripted.delete(key)
        host.reply(view, turnId, script)
        return true
      }
      if (USES_AGENTS.test(message.text)) {
        agentsDemo(view, turnId)
        return true
      }
      // Litch 子会话的两出要设备有会话树
      if (!host.treeOn(view.deviceId)) return false
      if (SPAWNS.test(message.text)) {
        spawnDemo(view, turnId)
        return true
      }
      if (PROPOSES.test(message.text)) {
        proposeDemo(view, turnId)
        return true
      }
      return false
    },

    ended(view, status) {
      const { deviceId, sessionId } = view
      const agent = agents.get(sameKey(deviceId, sessionId))
      if (agent) {
        if (!agent.done) agentDone(agent)
        return
      }
      const summary = host.summary(deviceId, sessionId)
      const lineage = summary?.lineage
      if (lineage) {
        // 回报：最后一条回答的开头
        const turn = view.turns.at(-1)
        const answer = [...(turn?.itemIds ?? [])]
          .reverse()
          .map((id) => view.items[id])
          .find((item) => item?.kind === 'agentMessage')
        const excerpt =
          answer?.kind === 'agentMessage'
            ? Array.from(answer.text).slice(0, SESSION_TREE_LIMITS.noteChars).join('')
            : ''
        const key = sameKey(deviceId, lineage.parentId)
        const notes = (pending.get(key) ?? []).filter((note) => note.threadId !== sessionId)
        notes.push({ threadId: sessionId, title: lineage.title, status, excerpt })
        pending.set(key, notes)
        tryWake(deviceId, lineage.parentId)
      }
      // 自己是父会话：刚停下，看看攒着的回报够不够唤醒自己
      tryWake(deviceId, sessionId)
    },

    notesFor(view) {
      const key = sameKey(view.deviceId, view.sessionId)
      wakes.delete(key)
      const notes = pending.get(key)
      if (!notes?.length) return undefined
      pending.delete(key)
      return { kind: 'notes', notes }
    },

    agentView(deviceId, sessionId) {
      return agents.get(sameKey(deviceId, sessionId))?.view
    },

    command(name, params) {
      if (
        name.startsWith('session.proposal.') ||
        name === 'session.spawn' ||
        name === 'session.detach'
      ) {
        const { deviceId } = params as { deviceId: string }
        if (!host.treeOn(deviceId)) {
          throw new ChannelError('unsupported', '这台设备没有会话树')
        }
      }
      if (name === 'session.spawn') {
        const { deviceId, parentId, ...rest } = params as Commands['session.spawn']['params']
        const parent = host.view(deviceId, parentId)
        const sessionId = startChild(parent, {
          title: rest.title.trim() || rest.prompt.split('\n')[0]?.slice(0, 40) || '…',
          prompt: rest.prompt,
          harness: rest.harness ?? null,
          kind: rest.kind,
          origin: 'user',
          wakeParent: rest.wakeParent,
          reply: null,
          settings: {
            ...(rest.model ? { model: rest.model } : {}),
            ...(rest.effort ? { effort: rest.effort } : {}),
          },
          ...(rest.workspaceId ? { workspaceId: rest.workspaceId } : {}),
          ...(rest.cwd ? { cwd: rest.cwd } : {}),
        })
        return { sessionId }
      }
      if (name === 'session.detach') {
        const { deviceId, sessionId } = params as Commands['session.detach']['params']
        if (!host.summary(deviceId, sessionId)?.lineage) {
          throw new ChannelError('rejected', '这个会话不是子会话')
        }
        host.updateSummary(deviceId, sessionId, { lineage: null })
        return {}
      }
      if (name === 'session.proposal.accept' || name === 'session.proposal.dismiss') {
        const { deviceId, sessionId, proposalId } =
          params as Commands['session.proposal.accept']['params']
        const view = host.view(deviceId, sessionId)
        const proposal = view.proposals.find((entry) => entry.id === proposalId)
        if (!proposal || proposal.expiresAt <= host.now()) {
          throw new ChannelError('notFound', '这个提案已经不在了')
        }
        setProposals(
          view,
          view.proposals.filter((entry) => entry.id !== proposalId),
        )
        if (name === 'session.proposal.dismiss') return {}
        const reply = scripted.get(`proposal:${proposalId}`) ?? null
        scripted.delete(`proposal:${proposalId}`)
        return {
          sessionId: startChild(view, {
            title: proposal.title,
            prompt: proposal.prompt,
            harness: proposal.harness,
            kind: proposal.kind,
            origin: 'proposal',
            wakeParent: proposal.wakeParent,
            reply,
          }),
        }
      }
      if (name === 'session.agents') {
        const { deviceId, sessionId } = params as Commands['session.agents']['params']
        const list: AgentThreadView[] = [...agents.values()]
          .filter((entry) => entry.deviceId === deviceId && entry.parentId === sessionId)
          .map((entry) => ({
            id: entry.view.sessionId,
            nickname: entry.spec.nickname,
            role: entry.spec.role,
            title: entry.spec.prompt,
            status: host.running(entry.view) ? 'running' : 'idle',
            canInput: entry.spec.canInput,
            updatedAt: entry.view.turns.at(-1)?.startedAt ?? host.now(),
          }))
        return { agents: list }
      }
      return undefined
    },
  }
}
