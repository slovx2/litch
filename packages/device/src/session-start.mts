// 派一个子会话（模型的 litch_sessions.start、用户的 litch/session/start、开始提案（acceptProposal）都走这里）。
// fresh：在目标 harness 上 thread/start（目录缺省是父会话的），再 turn/start 发简报；fork：同 harness 的 thread/fork
// 再 turn/start。审批策略、沙箱取父会话和请求值里更严的那个；模型、强度不限，没给的取开始那一刻父会话的
//（目标 harness 和父会话不同时用那边的默认；那个模型没有这一档强度的也用默认）。建好后记父子关系、登记进会话索引
// 和设备级工作区（跟父会话在同一个工作区，除非指定了别的），给每条客户端连接发 thread/started 和父子关系的通知。
// 目录：worktree 为真的在设备层新建一个工作树（从宿主分支的最新提交切），为假的共用父会话的目录；没定的看宿主——
// 父会话是某棵设备层工作树的主人、或者目录就在某棵里（共用着它），就开新的，否则共用（placement）。

import { realpathSync } from 'node:fs'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import {
  isPresentationSpec,
  PRESENTATION_SPEC,
} from '../../protocol/src/client-tools-presentation.mjs'
import {
  SESSION_TOOL_LIMITS,
  SESSION_TOOLS,
  sessionTools,
} from '../../protocol/src/client-tools-sessions.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  SESSION_TREE_LIMITS,
  type SessionLineageKind,
  type SessionLineageOrigin,
} from '../../protocol/src/session-tree.mjs'
import type { Worktree, WorktreeFrom } from '../../protocol/src/worktrees.mjs'
import type { EngineLink } from './engine-link.mjs'
import { lineInstructions } from './manager-rules.mjs'
import type { SessionTree } from './session-tree.mjs'
import { DeviceError, isObject } from './wire.mjs'
import { worktreeCwd } from './worktrees.mjs'

export interface ChildSpec {
  /** 不给是父会话的 harness */
  harness?: string | null
  model?: string | null
  effort?: string | null
  /** 不给是父会话的目录 */
  cwd?: string | null
  /** 设备级工作区。不给跟父会话在同一个 */
  projectId?: string | null
  kind: SessionLineageKind
  title: string
  /** 任务 */
  prompt: string
  /** 任务之前的背景（fresh 时单成一段放在任务前面；fork 不用）。不给、空串是没有 */
  background?: string | null
  wakeParent: boolean
  approvalPolicy?: unknown
  sandbox?: unknown
  /** 从哪个提案开始的（用户点了提案上的“开始”） */
  proposalId?: string | null
  /**
   * 交接（litch_sessions.hand_off）：fork 分叉到这个回合之前（不带它，免得子会话看到那条无关的新消息），
   * 第一条消息说明它接手的是父会话做到一半的任务，prompt 是剩下的计划
   */
  handOffBefore?: string | null
  /** 要不要自己的工作树：真开新的，假共用父会话的目录，不给照宿主算（placement） */
  worktree?: boolean | null
}

/** 派不出来：说明是给人（或模型）看的 */
export class StartRefused extends Error {
  readonly kind: 'invalid' | 'blocked'

  constructor(kind: 'invalid' | 'blocked', message: string) {
    super(message)
    this.kind = kind
  }
}

/** 审批策略从松到严：never 最松，untrusted 最严；细分的（granular）和 on-request 算一档 */
function approvalRank(value: unknown): number | null {
  if (value === 'never') return 0
  if (value === 'on-failure' || value === 'on-request') return 1
  if (isObject(value) && 'granular' in value) return 1
  if (value === 'untrusted') return 2
  return null
}

/** 沙箱从松到严。父会话报的是策略对象（type），请求里给的是模式的名字 */
function sandboxMode(value: unknown): string | null {
  const type = isObject(value) ? value.type : value
  if (type === 'dangerFullAccess' || type === 'danger-full-access') return 'danger-full-access'
  if (type === 'workspaceWrite' || type === 'workspace-write' || type === 'externalSandbox')
    return 'workspace-write'
  if (type === 'readOnly' || type === 'read-only') return 'read-only'
  return null
}

const SANDBOX_RANK: Record<string, number> = {
  'danger-full-access': 0,
  'workspace-write': 1,
  'read-only': 2,
}

/** 权限预设的标识对应的沙箱（shared/src/harness-declaration.mts 的 PRESET） */
const PRESET_SANDBOX: Record<string, string> = {
  ':read-only': 'read-only',
  ':workspace': 'workspace-write',
  ':danger-full-access': 'danger-full-access',
}

/**
 * 这个 harness 最严给得到哪一档沙箱：看它在 runtime/info 里声明的权限预设。
 * 没声明预设的（原生 codex，照协议的沙箱参数办）、一个都不认识的是 null，当作哪档都给得了
 */
function strictestSandbox(link: EngineLink): string | null {
  const presets = link.runtime?.permissionPresets
  if (!Array.isArray(presets)) return null
  let best: string | null = null
  for (const preset of presets) {
    const mode =
      isObject(preset) && typeof preset.id === 'string' ? PRESET_SANDBOX[preset.id] : null
    if (mode && (best === null || (SANDBOX_RANK[mode] ?? 0) > (SANDBOX_RANK[best] ?? 0)))
      best = mode
  }
  return best
}

/**
 * 派到 harness 上的子会话会不会比父会话宽：父会话的沙箱比目标 harness 最严的那一档还严（比如父会话“项目内”，
 * 目标是没有沙箱的 Pi）。宽的话返回子会话实际会是的那一档，收得紧（或者判断不了）是 null
 */
export async function widerSandbox(
  tree: SessionTree,
  parentId: string,
  harness: string,
): Promise<string | null> {
  const parentHarness = await tree.owner(parentId)
  const { config } = await parentSettings(tree, parentId, parentHarness)
  const theirs = sandboxMode(config?.sandbox)
  const link = await tree.link(harness)
  const best = strictestSandbox(link)
  if (theirs === null || best === null) return null
  return (SANDBOX_RANK[best] ?? 0) < (SANDBOX_RANK[theirs] ?? 0) ? best : null
}

/**
 * 父会话现在的设置（审批策略、沙箱、目录）：恢复一下就拿得到，顺带让设备进程的连接订阅它。
 * 订阅留到父会话这一回合结束，用不着了由会话树退订（releaseLater）
 */
export async function parentSettings(
  tree: SessionTree,
  parentId: string,
  parentHarness: string,
): Promise<{ link: EngineLink; config: Record<string, unknown> | null }> {
  const resumed = await tree.watch(parentHarness, parentId)
  const link = await tree.link(parentHarness)
  // 已经订阅着的 watch 不再恢复，给的是 null：设置照样要读
  const config = resumed ?? (await link.request('thread/resume', { threadId: parentId }))
  tree.releaseLater(parentHarness, parentId)
  return { link, config: isObject(config) ? config : null }
}

/** 子会话的审批策略、沙箱：不宽于父会话。父会话报不出来的那一项照请求的给（都没有就不带，用引擎的缺省） */
export function tightened(
  parent: Record<string, unknown> | null,
  requested: { approvalPolicy?: unknown; sandbox?: unknown },
): { approvalPolicy?: unknown; sandbox?: string } {
  const out: { approvalPolicy?: unknown; sandbox?: string } = {}
  const mine = approvalRank(parent?.approvalPolicy)
  const asked = approvalRank(requested.approvalPolicy)
  if (mine !== null && (asked === null || asked < mine)) out.approvalPolicy = parent?.approvalPolicy
  else if (asked !== null) out.approvalPolicy = requested.approvalPolicy
  const theirs = sandboxMode(parent?.sandbox)
  const wanted = sandboxMode(requested.sandbox)
  const rank = (mode: string | null) => (mode === null ? null : (SANDBOX_RANK[mode] ?? null))
  const parentRank = rank(theirs)
  const wantedRank = rank(wanted)
  if (theirs !== null && (wantedRank === null || (parentRank !== null && wantedRank < parentRank)))
    out.sandbox = theirs
  else if (wanted !== null) out.sandbox = wanted
  return out
}

/**
 * 会话给人看的名字：起过名的用名字；没有的话，Litch 子会话用派出时给的标题 given（它的第一句话是派出说明），
 * 别的用预览（第一句话）
 */
export function threadTitle(thread: Record<string, unknown> | null, given?: string): string {
  if (!thread) return ''
  if (typeof thread.name === 'string' && thread.name.trim()) return thread.name.trim()
  if (given?.trim()) return given.trim()
  return typeof thread.preview === 'string' ? thread.preview.trim().slice(0, 80) : ''
}

/**
 * 子会话收到的第一条消息：由哪个会话派出、背景（fresh 且给了才有）、任务是什么、做完怎么回报。
 * fork 带着整段对话，不放背景。handOff：交接出来的分叉，说明它接手的是父会话做到一半的任务，prompt 是剩下的计划
 */
export function briefing(
  kind: SessionLineageKind,
  parent: { id: string; harness: string; title: string },
  title: string,
  prompt: string,
  handOff = false,
  background = '',
): string {
  const who = `"${parent.title || parent.id}" (${parent.id}, ${parent.harness})`
  const head = handOff
    ? `[Litch] You are taking over a task that ${who} was in the middle of: a new, unrelated user message arrived there, so it handed this task to you and went on to answer that message. You have the conversation above, up to the turn before that message; finish the task here as a separate sub-session.`
    : kind === 'fork'
      ? `[Litch] This session is a fork of ${who}: you have that conversation above, but you are now a separate sub-session and the original goes on without you.`
      : `[Litch] Another session on this device started this one: ${who}. You cannot see that conversation; the user can open this session and talk to you directly.`
  const context = kind === 'fresh' && !handOff ? background.trim() : ''
  return [
    head,
    '',
    ...(context ? [`Background:\n${context}`, ''] : []),
    `Task: ${title}`,
    '',
    handOff ? `Remaining plan:\n${prompt}` : prompt,
    '',
    'When you are done, end your turn with a short summary of the result and anything left open: Litch passes the beginning of your final answer back to the session that started you. Ask for decisions here through the normal request tools. Your parent may answer eligible blocking requests explicitly through litch_sessions.respond; ordinary messages are not answers. Secret inputs require the user.',
  ].join('\n')
}

/**
 * 子会话建的时候带哪些动态工具：父会话建时客户端给的那些（目标引擎认客户端工具才带），开关开着再加上 litch_sessions
 *（按“每回合收尾”开关和子会话所在 harness 的“任务卡”开关给的那份）
 */
function childTools(
  tree: SessionTree,
  parentId: string,
  harness: string,
  link: EngineLink,
): unknown[] | null {
  const extensions = Array.isArray(link.runtime?.extensions) ? link.runtime.extensions : []
  if (!extensions.includes(EXTENSION.clientTools)) return null
  // 呈现风格看子会话建在哪个 harness 上（原生 codex 不带，按设备侧的 link.native 认），不照搬父会话的
  const inherited = (tree.store.tools(parentId) ?? []).filter(
    (spec) =>
      !isPresentationSpec(spec) &&
      (!isObject(spec) ||
        (spec.name !== SESSION_TOOLS.name && spec.name !== CLIENT_TOOL_NAMESPACE.manager)),
  )
  const manager = tree.managers?.lines.managerFor(parentId)
  const sessions = sessionTools(tree.host.wrapUp(), tree.host.taskCards(harness))
  if (manager) sessions.instructions = `${sessions.instructions}\n\n${lineInstructions(manager)}`
  return [
    ...inherited,
    ...(tree.host.enabled() || manager ? [sessions] : []),
    ...(link.native ? [] : [PRESENTATION_SPEC]),
  ]
}

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

/**
 * 这一档强度子会话用得上没有：问目标引擎的 model/list，找到那个模型（没给模型是缺省的那个）且它列了支持的强度、
 * 里面没有这一档的，不带（用那边的默认）。问不到、找不到模型、没列强度的照带
 */
async function fitEffort(
  link: EngineLink,
  model: string | null,
  effort: string | null,
): Promise<string | null> {
  if (!effort) return null
  try {
    const result = await link.request('model/list', { includeHidden: true })
    const data = isObject(result) && Array.isArray(result.data) ? result.data.filter(isObject) : []
    const entry = model
      ? data.find((one) => one.model === model || one.id === model)
      : data.find((one) => one.isDefault === true)
    const supported = Array.isArray(entry?.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map((one) => (isObject(one) ? one.reasoningEffort : one))
      : null
    return supported && !supported.includes(effort) ? null : effort
  } catch {
    return effort
  }
}

/**
 * 宿主：父会话（或它共用着的祖先）在哪棵设备层工作树里。父会话是哪棵的主人，或者目录在哪棵下面（共用着它）；
 * 删了的也算（“有过”，目录字符串还在）。cwd 是子会话要用的目录，模型另给了目录时只看目录。没有是 null
 */
export function hostWorktree(
  tree: SessionTree,
  parentId: string,
  cwd: string | null,
  ownDir: boolean,
): Worktree | null {
  const worktrees = tree.host.worktrees
  if (!worktrees) return null
  const found = cwd === null ? null : worktrees.containing(cwd)
  return found ?? (ownDir ? null : worktrees.forThread(parentId))
}

/**
 * 提案上没人定时子会话会不会开工作树（卡上开关的初值）。cwd 是提案给的目录；没给时看父会话现在的目录
 *（父会话是哪棵的主人就不用问；设备上一棵都没有就不用问）
 */
export async function worktreeDefault(
  tree: SessionTree,
  parentId: string,
  cwd: string | null,
): Promise<boolean> {
  const worktrees = tree.host.worktrees
  if (!worktrees || worktrees.list().length === 0) return false
  if (cwd) return hostWorktree(tree, parentId, cwd, true) !== null
  if (worktrees.forThread(parentId)) return true
  try {
    const { config } = await parentSettings(tree, parentId, await tree.owner(parentId))
    const thread = isObject(config?.thread) ? config.thread : null
    const dir =
      (typeof config?.cwd === 'string' ? config.cwd : null) ||
      (typeof thread?.cwd === 'string' ? thread.cwd : null)
    return hostWorktree(tree, parentId, dir, false) !== null
  } catch {
    return false
  }
}

/** 子会话在哪：共用目录，或者新建一棵工作树（从哪切） */
export type Placement = { kind: 'share' } | { kind: 'worktree'; from: WorktreeFrom }

/**
 * 照规则定子会话的目录：明说了的照办（要工作树却没有 git、没有目录的拒绝），没说的宿主在工作树里就开新的。
 * 新的从宿主分支的最新提交切（宿主没提交的改动不带）；宿主在普通目录、明说要的，从那个目录当前的 HEAD 切
 */
export function placement(
  tree: SessionTree,
  parentId: string,
  cwd: string | null,
  asked: boolean | null | undefined,
  ownDir = false,
): Placement {
  if (asked === false) return { kind: 'share' }
  const host = hostWorktree(tree, parentId, cwd, ownDir)
  if (asked == null && !host) return { kind: 'share' }
  if (!tree.host.worktrees) {
    if (asked)
      throw new StartRefused(
        'invalid',
        'This device cannot create worktrees (git is not installed there). Leave worktree out or set it to false.',
      )
    return { kind: 'share' }
  }
  return {
    kind: 'worktree',
    from: host ? { kind: 'branch', branch: host.branch } : { kind: 'head' },
  }
}

/** 名额覆盖建工作树、建会话、开回合全过程；失败也释放。 */
export async function startChild(
  tree: SessionTree,
  parentId: string,
  spec: ChildSpec,
  origin: SessionLineageOrigin,
): Promise<{ threadId: string; harness: string; branch: string | null }> {
  const reservation = await tree.managers?.lines.reserve(parentId, null)
  try {
    return await createChild(tree, parentId, spec, origin, (id) => reservation?.bind(id))
  } finally {
    reservation?.release()
  }
}

async function createChild(
  tree: SessionTree,
  parentId: string,
  spec: ChildSpec,
  origin: SessionLineageOrigin,
  bind: (threadId: string) => void,
): Promise<{ threadId: string; harness: string; branch: string | null }> {
  const title = spec.title.trim().slice(0, 120)
  if (!title) throw new StartRefused('invalid', 'title must not be empty.')
  if (!spec.prompt.trim()) throw new StartRefused('invalid', 'prompt must not be empty.')
  if (spec.prompt.length > SESSION_TOOL_LIMITS.messageChars)
    throw new StartRefused(
      'invalid',
      `prompt is longer than ${SESSION_TOOL_LIMITS.messageChars} characters; shorten it and point to files instead.`,
    )
  if ((spec.background ?? '').length > SESSION_TOOL_LIMITS.messageChars)
    throw new StartRefused(
      'invalid',
      `background is longer than ${SESSION_TOOL_LIMITS.messageChars} characters; shorten it and point to files instead.`,
    )
  const parentHarness = await tree.owner(parentId)
  const manager = tree.managers?.lines.managerFor(parentId)
  const harness = spec.harness || manager?.dispatch.harness || manager?.harness || parentHarness
  if (!tree.host.harnesses().some((source) => source.id === harness))
    throw new StartRefused('invalid', `There is no harness "${harness}" on this device.`)
  if (spec.kind === 'fork' && harness !== parentHarness)
    throw new StartRefused(
      'invalid',
      `fork only works within the same harness (${parentHarness}); use kind "fresh" with a full prompt for ${harness}.`,
    )
  const live = tree.store.childrenOf(parentId).filter((child) => tree.isActive(child.threadId))
  if (live.length >= SESSION_TREE_LIMITS.liveChildren)
    throw new StartRefused(
      'blocked',
      `This session already has ${live.length} sub-sessions running (the limit is ${SESSION_TREE_LIMITS.liveChildren}). Wait for one to finish first.`,
    )
  if (spec.projectId) tree.host.workspaces.requireProject(spec.projectId)
  const { link: parentLink, config: parentConfig } = await parentSettings(
    tree,
    parentId,
    parentHarness,
  )
  const parentThread = isObject(parentConfig?.thread) ? parentConfig.thread : null
  const permissions = tightened(parentConfig, spec)
  const link = harness === parentHarness ? parentLink : await tree.link(harness)
  const managerFork = spec.kind === 'fork' && Boolean(tree.managers?.store.forThread(parentId))
  // Claude 的 thread/fork 经 saveRuntimeSettings 替换动态工具；其余现有引擎会原样继承，不能假装已经隔离。
  if (managerFork && (link.native || link.runtime?.engine !== 'claude-code'))
    throw new StartRefused(
      'invalid',
      'This harness cannot replace manager tools when forking a line. Use kind fresh with a self-contained brief.',
    )
  const tools =
    spec.kind === 'fresh' || managerFork ? childTools(tree, parentId, harness, link) : null
  // 模型、强度没给的取父会话现在的；harness 不同时不带，用那边的默认。父会话自己那一对不用再问
  const same = harness === parentHarness
  const parentModel = same ? textOf(parentConfig?.model) : null
  const parentEffort = same ? textOf(parentConfig?.reasoningEffort) : null
  // 孙线默认仍取经理当前的型号和强度，不能误取直接父线的覆盖值。
  const managerConfig =
    manager && harness === manager.harness
      ? parentId === manager.threadId
        ? parentConfig
        : (await parentSettings(tree, manager.threadId, manager.harness)).config
      : null
  const model =
    spec.model ||
    manager?.dispatch.model ||
    (manager
      ? harness === manager.harness
        ? (textOf(managerConfig?.model) ?? manager.model)
        : null
      : parentModel)
  const wanted =
    spec.effort ||
    manager?.dispatch.effort ||
    (manager
      ? harness === manager.harness
        ? (textOf(managerConfig?.reasoningEffort) ?? manager.effort)
        : null
      : parentEffort)
  const effort =
    wanted && (wanted !== parentEffort || model !== parentModel)
      ? await fitEffort(link, model, wanted)
      : wanted
  const cwd =
    spec.cwd ||
    (typeof parentConfig?.cwd === 'string' ? parentConfig.cwd : null) ||
    (typeof parentThread?.cwd === 'string' ? parentThread.cwd : null)
  const worktree = spec.worktree ?? manager?.dispatch.worktree
  const place = placement(tree, parentId, cwd, worktree, Boolean(spec.cwd))
  const made =
    place.kind === 'worktree'
      ? await newWorktree(tree, cwd, place.from, title, worktree === true)
      : null
  const where = made ? worktreeCwd(made) : cwd
  let created: unknown
  try {
    created =
      spec.kind === 'fork'
        ? await link.request('thread/fork', {
            threadId: parentId,
            ...(spec.handOffBefore ? { beforeTurnId: spec.handOffBefore } : {}),
            ...(managerFork && tools ? { dynamicTools: tools } : {}),
            ...(made ? { cwd: where } : {}),
            ...(model ? { model } : {}),
            ...permissions,
          })
        : await link.request('thread/start', {
            ...(where ? { cwd: where } : {}),
            ...(model ? { model } : {}),
            ...permissions,
            ...(tools?.length ? { dynamicTools: tools } : {}),
          })
  } catch (error) {
    if (made) void tree.host.worktrees?.abandon(made.id)
    throw error
  }
  const thread = isObject(created) && isObject(created.thread) ? created.thread : null
  if (!thread || typeof thread.id !== 'string') {
    if (made) void tree.host.worktrees?.abandon(made.id)
    throw new Error(`${harness} 没有给回新会话`)
  }
  const threadId = thread.id
  // 分叉时不是每个引擎都认 cwd（Pi、OpenCode、通用 ACP 照源会话的目录）：没换过去的，刚建的工作树删掉、共用父会话的目录
  let branch: string | null = null
  if (made && sameDir(thread.cwd, where)) {
    tree.host.worktrees?.own(made.id, threadId)
    branch = made.branch
  } else {
    if (made) {
      tree.host.log(`${harness} 分叉时没用新工作树的目录，子会话 ${threadId} 共用父会话的目录`)
      void tree.host.worktrees?.abandon(made.id)
    }
    // 共用着某个工作树的记下来：主人归档时转给还没归档的它（worktree-life.mts）
    const dir = typeof thread.cwd === 'string' ? thread.cwd : where
    const shared = hostWorktree(tree, parentId, dir, true)
    if (shared) tree.host.worktrees?.share(shared.id, threadId)
  }
  tree.noteSubscribed(harness, threadId)
  // 不起名的话引擎拿第一条消息（派出说明）当标题，侧栏里一排子会话都是同一句开头
  await link.request('thread/name/set', { threadId, name: title }).catch((error: unknown) => {
    tree.host.log(
      `子会话 ${threadId} 起名失败：${error instanceof Error ? error.message : String(error)}`,
    )
  })
  const { index, workspaces, store } = tree.host
  index.see({ id: threadId, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral }, harness)
  const projectId = spec.projectId || workspaces.projectOf(parentId)
  if (projectId) workspaces.adoptThread(threadId, projectId)
  store.addLineage({
    threadId,
    parentThreadId: parentId,
    harness,
    kind: spec.kind,
    origin,
    title,
    prompt: spec.prompt,
    wakeParent: spec.wakeParent,
    createdAt: Math.floor(Date.now() / 1000),
    ...(spec.proposalId ? { proposalId: spec.proposalId } : {}),
  })
  bind(threadId)
  if (tools) store.setTools(threadId, tools)
  tree.host.threadStarted(harness, { ...thread })
  tree.lineageChanged(threadId)
  const text = briefing(
    spec.kind,
    {
      id: parentId,
      harness: parentHarness,
      title: threadTitle(parentThread, store.parentOf(parentId)?.title),
    },
    title,
    spec.prompt,
    Boolean(spec.handOffBefore),
    spec.background ?? '',
  )
  const started = await link.request('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    ...(effort ? { effort } : {}),
  })
  if (isObject(started?.turn))
    tree.turnEvent(harness, 'turn/started', { threadId, turn: started.turn })
  tree.host.log(
    `会话 ${parentId} 派出子会话 ${threadId}（${harness}，${spec.kind}，${origin}${branch ? `，工作树分支 ${branch}` : ''}）`,
  )
  return { threadId, harness, branch }
}

/** 两个目录是不是同一个（引擎可能把路径规范化过） */
function sameDir(given: unknown, wanted: string | null): boolean {
  if (typeof given !== 'string' || !wanted) return false
  if (given === wanted) return true
  try {
    return realpathSync(given) === realpathSync(wanted)
  } catch {
    return false
  }
}

/**
 * 给子会话建工作树。明说要的建不成就拒绝（说明原因）；照缺省开的建不成（宿主的分支删了之类）退回共用目录
 */
async function newWorktree(
  tree: SessionTree,
  cwd: string | null,
  from: WorktreeFrom,
  title: string,
  asked: boolean,
): Promise<Worktree | null> {
  const worktrees = tree.host.worktrees
  if (!worktrees || !cwd) {
    if (asked)
      throw new StartRefused(
        'invalid',
        'This session has no folder, so there is nothing to make a worktree from.',
      )
    return null
  }
  try {
    return await worktrees.create({ cwd, from, title })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (asked)
      throw new StartRefused(
        'invalid',
        `Could not create a worktree from ${cwd}: ${reason}. Leave worktree out or set it to false to work in this session's folder.`,
      )
    tree.host.log(`子会话的工作树没建成（${reason}），共用父会话的目录`)
    return null
  }
}

/** 从提案开始时改的东西（用户在卡片上改了再开始）。不给的照提案；空字符串是清掉提案里的值、用缺省（父会话的） */
export interface ProposalOverrides {
  harness?: string
  model?: string
  effort?: string
  cwd?: string
  projectId?: string
  kind?: SessionLineageKind
  title?: string
  prompt?: string
  /** 空串是去掉提案里的背景 */
  background?: string
  approvalPolicy?: unknown
  sandbox?: unknown
  /** 子会话停下后要不要唤醒父会话。不给照提案 */
  wakeParent?: boolean
  /** 要不要自己的工作树。不给照提案（提案也没定就照缺省） */
  worktree?: boolean
}

/**
 * 开始一个 pending 的提案：用户点“开始”（litch/sessionProposal/accept）和模型的 litch_sessions.accept 都走这里。
 * 照提案（加上用户改的）派子会话，origin 是 proposal、带 proposalId，起好后提案标 started。
 * from 是 chosen 时开始的是用户选了新会话的 offer 卡（模型补的简报在 overrides 里）。
 * 同一个提案正在开始时再来一次抛错；撤回、不要会等它起完（tree.accepting）
 */
export async function acceptProposal(
  tree: SessionTree,
  proposalId: string,
  overrides: ProposalOverrides = {},
  from: 'pending' | 'chosen' = 'pending',
): Promise<{ threadId: string; harness: string; branch: string | null }> {
  if (tree.accepting.has(proposalId))
    throw new DeviceError('unsupported', `提案 ${proposalId} 正在开始`)
  const proposal = tree.pendingProposal(proposalId, from)
  const pick = (value: string | undefined, fallback: string | null) =>
    value === undefined ? fallback : value || null
  const started = startChild(
    tree,
    proposal.threadId,
    {
      harness: pick(overrides.harness, proposal.harness),
      model: pick(overrides.model, proposal.model),
      effort: pick(overrides.effort, proposal.effort ?? null),
      cwd: pick(overrides.cwd, proposal.cwd),
      projectId: overrides.projectId || null,
      kind: overrides.kind ?? proposal.kind,
      title: overrides.title ?? proposal.title,
      prompt: overrides.prompt ?? proposal.prompt,
      background: overrides.background ?? proposal.background ?? '',
      wakeParent: overrides.wakeParent ?? proposal.wakeParent,
      approvalPolicy: overrides.approvalPolicy,
      sandbox: overrides.sandbox,
      proposalId: proposal.id,
      worktree: overrides.worktree ?? proposal.worktree ?? null,
    },
    'proposal',
  )
  tree.accepting.set(proposalId, started)
  try {
    const child = await started
    tree.settleProposal(proposalId, 'started', child.threadId, [from])
    return child
  } finally {
    tree.accepting.delete(proposalId)
  }
}
