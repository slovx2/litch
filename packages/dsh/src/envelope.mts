import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { type DshThread, type DshTurn, knownPreset, type Preset } from './projection.mjs'
import type { DshServer, LiveThread } from './server.mjs'
import { versions } from './versions.mjs'

/** dsh 的权限预设对应的权限档标识 */
export const PROFILE: Record<Preset, string> = {
  'read-only': ':read-only',
  'workspace-write': ':workspace',
  'danger-full-access': ':danger-full-access',
}

// dsh 的沙箱只约束文件写入，不限制网络，这里如实回报 networkAccess。
function sandbox(preset: Preset, cwd: string): any {
  if (preset === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (preset === 'read-only') return { type: 'readOnly', networkAccess: true }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

// session/list 的一项转成线程摘要；已加载的线程以跟随流里的状态为准。
export function summary(item: any): DshThread {
  const values = item.projections?.values ?? {}
  const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed ?? null
  const updatedAt = Math.floor(Number(item.updatedAt ?? Date.now()) / 1000)
  return {
    id: item.sessionId,
    cwd: item.cwd ?? '',
    name: typeof values.title === 'string' ? values.title : null,
    preview: String(values.turnOutline?.[0]?.prompt ?? values.title ?? '').slice(0, 200),
    createdAt: updatedAt,
    updatedAt,
    model: selection ? `${selection.provider}/${selection.model}` : null,
    effort: selection?.reasoningEffort ?? null,
    preset: knownPreset(values.permissions?.currentValue) ?? 'workspace-write',
    // 清单项的 parentSessionId 子代理和分叉出来的会话都有，origin 是 subagent 的才是子代理
    parentThreadId: item.origin === 'subagent' ? (item.parentSessionId ?? null) : null,
    forkedFromId: item.origin === 'subagent' ? null : (item.parentSessionId ?? null),
    ephemeral: false,
  }
}

export function envelope(s: DshServer, thread: DshThread, turns: DshTurn[] = []): any {
  const metadata = s.store.getMeta('thread', thread.id) ?? {}
  const live = s.live.get(thread.id) ?? s.ephemeral.get(thread.id)
  // 没打开的会话，预览和名字是 dsh 的清单给的，适配器记过的照记的报（DshServer.display）：预览是用户发来的
  // 那句话；清单给的名字是记下的兜底标题、或者没有名字时（清单出自它的投影缓存，缓存可能还停在会话刚建好、
  // 还没有标题的时候，见 DshServer.blank），名字是记下的（模型起的、用户改的，或者没有），
  // 别的照 dsh 的（适配器没跟着的时候 dsh 那边改了名）。
  const shown = live ? null : s.store.getMeta('display', thread.id)
  const subagent = thread.parentThreadId ? s.subagentInfo(thread.id) : null
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: thread.forkedFromId,
    preview: shown?.preview || thread.preview,
    name:
      shown && (thread.name === null || thread.name === shown.fallback) ? shown.name : thread.name,
    modelProvider: thread.model?.split('/')[0] ?? 'dsh',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    historyMode: 'legacy',
    threadSource: thread.parentThreadId ? 'subagent' : 'user',
    section:
      metadata.sectionId === PINNED_SECTION_ID
        ? PINNED_SECTION
        : metadata.sectionId
          ? (s.store.getMeta('section', metadata.sectionId) ?? null)
          : null,
    sectionEnteredAt: metadata.sectionEnteredAt ?? null,
    isPinned: metadata.sectionId === PINNED_SECTION_ID,
    // dsh 的子代理只有后台可继续（continuable）的能接着发消息（经 subagents/prompt），别的跑完就结束了；
    // 不知道是哪种的（没见过派它的会话，也没打开过它）按不能报
    canAcceptDirectInput: !thread.parentThreadId || subagent?.mode === 'continuable',
    activePermissionProfile: PROFILE[live?.preset ?? thread.preset],
    status: live?.projection.status() ?? { type: 'idle' },
    // dsh 的会话文件不是 Codex rollout，不交给桌面读取。
    path: null,
    cwd: thread.cwd,
    cliVersion: s.runtime.host?.version ?? versions.dshMinimum,
    source: thread.parentThreadId
      ? { subAgent: { thread_spawn: { parent_thread_id: thread.parentThreadId, depth: 1 } } }
      : 'appServer',
    parentThreadId: thread.parentThreadId,
    ephemeral: thread.ephemeral,
    gitInfo: null,
    // 子代理的标签（派它时给的 description）
    agentNickname: subagent?.label ?? null,
    agentRole: null,
    turns,
    projectId: s.projects.projectId(thread.id),
    ...metadata,
  }
}

// 带会话设置的应答（thread/start、thread/resume）和设置变了的通知。模型和强度报的是这个会话实际会用的，
// 没选过模型的新会话也有（见 DshServer.selection），和 model/list 里的标识对得上。
export async function settings(s: DshServer, live: LiveThread): Promise<any> {
  const { thread, turns } = live.projection
  const preset = live.preset ?? thread.preset
  const { model, effort } = await s.selection(thread)
  const modelProvider = model?.split('/')[0] ?? 'dsh'
  return {
    thread: { ...envelope(s, thread, turns), modelProvider },
    model: model ?? '',
    modelProvider,
    cwd: thread.cwd,
    approvalPolicy: preset === 'danger-full-access' ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    sandbox: sandbox(preset, thread.cwd),
    sandboxPolicy: sandbox(preset, thread.cwd),
    activePermissionProfile: { id: PROFILE[preset], extends: null },
    permissions: PROFILE[preset],
    reasoningEffort: effort,
    collaborationMode: {
      mode: 'default',
      settings: {
        model: model ?? '',
        reasoning_effort: effort,
        developer_instructions: null,
      },
    },
  }
}
