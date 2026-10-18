// 派一个子会话（模型的 litch_sessions.start、用户的 litch/session/start、点了“开始”的提案都走这里）。
// fresh：在目标 harness 上 thread/start（目录缺省是父会话的），再 turn/start 发简报；fork：同 harness 的 thread/fork
// 再 turn/start。审批策略、沙箱取父会话和请求值里更严的那个；模型、强度不限。建好后记父子关系、登记进会话索引
// 和设备级工作区（跟父会话在同一个工作区，除非指定了别的），给每条客户端连接发 thread/started 和父子关系的通知。
import { SESSION_TOOL_LIMITS, SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  SESSION_TREE_LIMITS,
  type SessionLineageKind,
  type SessionLineageOrigin,
} from '../../protocol/src/session-tree.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { SessionTree } from './session-tree.mjs'
import { isObject } from './wire.mjs'

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
  prompt: string
  wakeParent: boolean
  approvalPolicy?: unknown
  sandbox?: unknown
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

/** 子会话收到的第一条消息：由哪个会话派出、任务是什么、做完怎么回报 */
export function briefing(
  kind: SessionLineageKind,
  parent: { id: string; harness: string; title: string },
  title: string,
  prompt: string,
): string {
  const who = `"${parent.title || parent.id}" (${parent.id}, ${parent.harness})`
  const head =
    kind === 'fork'
      ? `[Litch] This session is a fork of ${who}: you have that conversation above, but you are now a separate sub-session and the original goes on without you.`
      : `[Litch] Another session on this device started this one: ${who}. You cannot see that conversation; the user can open this session and talk to you directly.`
  return [
    head,
    '',
    `Task: ${title}`,
    '',
    prompt,
    '',
    'When you are done, end your turn with a short summary of the result and anything left open: Litch passes the beginning of your final answer back to the session that started you. If you need a decision, ask the user here; that session cannot answer for them.',
  ].join('\n')
}

/** 子会话建的时候带哪些动态工具：父会话建时客户端给的那些（目标引擎认客户端工具才带），开关开着再加上 litch_sessions */
function childTools(tree: SessionTree, parentId: string, link: EngineLink): unknown[] | null {
  const extensions = Array.isArray(link.runtime?.extensions) ? link.runtime.extensions : []
  if (!extensions.includes(EXTENSION.clientTools)) return null
  const inherited = (tree.store.tools(parentId) ?? []).filter(
    (spec) => !isObject(spec) || spec.name !== SESSION_TOOLS.name,
  )
  return tree.host.enabled() ? [...inherited, SESSION_TOOLS] : inherited
}

export async function startChild(
  tree: SessionTree,
  parentId: string,
  spec: ChildSpec,
  origin: SessionLineageOrigin,
): Promise<{ threadId: string; harness: string }> {
  const title = spec.title.trim().slice(0, 120)
  if (!title) throw new StartRefused('invalid', 'title must not be empty.')
  if (!spec.prompt.trim()) throw new StartRefused('invalid', 'prompt must not be empty.')
  if (spec.prompt.length > SESSION_TOOL_LIMITS.messageChars)
    throw new StartRefused(
      'invalid',
      `prompt is longer than ${SESSION_TOOL_LIMITS.messageChars} characters; shorten it and point to files instead.`,
    )
  const parentHarness = await tree.owner(parentId)
  const harness = spec.harness || parentHarness
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
  // 父会话现在的设置（审批策略、沙箱、目录）：恢复一下就拿得到，顺带让设备进程的连接订阅它
  const parentLink = await tree.link(parentHarness)
  const resumed = await parentLink.request('thread/resume', { threadId: parentId })
  tree.noteSubscribed(parentHarness, parentId)
  const parentConfig = isObject(resumed) ? resumed : null
  const parentThread = isObject(parentConfig?.thread) ? parentConfig.thread : null
  const permissions = tightened(parentConfig, spec)
  const link = harness === parentHarness ? parentLink : await tree.link(harness)
  const tools = spec.kind === 'fresh' ? childTools(tree, parentId, link) : null
  const cwd =
    spec.cwd ||
    (typeof parentConfig?.cwd === 'string' ? parentConfig.cwd : null) ||
    (typeof parentThread?.cwd === 'string' ? parentThread.cwd : null)
  const created =
    spec.kind === 'fork'
      ? await link.request('thread/fork', {
          threadId: parentId,
          ...(spec.model ? { model: spec.model } : {}),
          ...permissions,
        })
      : await link.request('thread/start', {
          ...(cwd ? { cwd } : {}),
          ...(spec.model ? { model: spec.model } : {}),
          ...permissions,
          ...(tools?.length ? { dynamicTools: tools } : {}),
        })
  const thread = isObject(created) && isObject(created.thread) ? created.thread : null
  if (!thread || typeof thread.id !== 'string') throw new Error(`${harness} 没有给回新会话`)
  const threadId = thread.id
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
  })
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
  )
  await link.request('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    ...(spec.effort ? { effort: spec.effort } : {}),
  })
  tree.host.log(`会话 ${parentId} 派出子会话 ${threadId}（${harness}，${spec.kind}，${origin}）`)
  return { threadId, harness }
}
