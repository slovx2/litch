import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { type Catalog, currentEffort, currentMode, currentModel, planMode } from './catalog.mjs'
import type { AcpThread, AcpTurn } from './projection.mjs'
import type { AcpServer, LiveThread } from './server.mjs'

/** 唯一的权限档（declaration.mts）：适配器不加沙箱，什么时候问由 agent 自己定 */
export const PROFILE = ':danger-full-access'

/** 会话对象。形状照 dsh 的入口（客户端读的那几个自己加的字段也一样） */
export function envelope(s: AcpServer, thread: AcpThread, turns: AcpTurn[] = []): any {
  const metadata = s.store.getMeta('thread', thread.id) ?? {}
  const live = s.live.get(thread.id) ?? s.ephemeral.get(thread.id)
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: thread.forkedFromId,
    preview: thread.preview,
    name: thread.name,
    modelProvider: s.agentId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    historyMode: 'legacy',
    threadSource: 'user',
    section:
      metadata.sectionId === PINNED_SECTION_ID
        ? PINNED_SECTION
        : metadata.sectionId
          ? (s.store.getMeta('section', metadata.sectionId) ?? null)
          : null,
    sectionEnteredAt: metadata.sectionEnteredAt ?? null,
    isPinned: metadata.sectionId === PINNED_SECTION_ID,
    canAcceptDirectInput: true,
    activePermissionProfile: PROFILE,
    status: live?.projection.status() ?? { type: 'idle' },
    // agent 的会话文件不是 Codex rollout，不交给桌面读取。
    path: null,
    cwd: thread.cwd,
    cliVersion: s.runtime.known?.agentInfo?.version || 'unknown',
    source: 'appServer',
    parentThreadId: null,
    ephemeral: thread.ephemeral,
    gitInfo: null,
    agentNickname: null,
    agentRole: null,
    turns,
    projectId: s.projects.projectId(thread.id),
    ...metadata,
  }
}

/** 会话现在的模型、强度、是不是计划模式：打开着的看 agent 报的，换了还没交给 agent 的以换的为准 */
export function selection(live: LiveThread): {
  model: string | null
  effort: string | null
  plan: boolean
} {
  const catalog: Catalog = live.projection
  const plan = planMode(catalog)
  return {
    model: live.pending.model ?? currentModel(catalog),
    effort: live.pending.effort ?? currentEffort(catalog),
    plan: live.pending.mode
      ? live.pending.mode === 'plan'
      : !!plan && currentMode(catalog) === plan,
  }
}

// 带会话设置的应答（thread/start、thread/resume、thread/fork）和设置变了的通知。
export function settings(s: AcpServer, live: LiveThread): any {
  const { thread, turns } = live.projection
  const { model, effort, plan } = selection(live)
  return {
    thread: envelope(s, thread, turns),
    model: model ?? '',
    modelProvider: s.agentId,
    cwd: thread.cwd,
    // 适配器不拦：agent 想问的时候才问
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    sandboxPolicy: { type: 'dangerFullAccess' },
    activePermissionProfile: { id: PROFILE, extends: null },
    permissions: PROFILE,
    reasoningEffort: effort,
    collaborationMode: {
      mode: plan ? 'plan' : 'default',
      settings: { model: model ?? '', reasoning_effort: effort, developer_instructions: null },
    },
  }
}
