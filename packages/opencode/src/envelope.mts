import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { OcThread, OcTurn } from './projection.mjs'
import type { LiveThread, OpencodeServer, Preset } from './server.mjs'
import { versions } from './versions.mjs'

// OpenCode 没有沙箱，三档的差别全在“问不问”和“给不给工具”（见 turns.mts 的 presetTools），
// 这里报的沙箱只是让客户端照档位显示：只读档报只读，项目内报可写项目目录，完全访问报无沙箱；联网三档都不限。
function sandbox(preset: Preset, cwd: string): any {
  if (preset === ':danger-full-access') return { type: 'dangerFullAccess' }
  if (preset === ':read-only') return { type: 'readOnly', networkAccess: true }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

const providerOf = (model: string | null | undefined) =>
  model?.includes('/') ? model.split('/')[0] : 'opencode'

export function envelope(s: OpencodeServer, thread: OcThread, turns: OcTurn[] = []): any {
  const metadata = s.store.getMeta('thread', thread.id) ?? {}
  const live = s.live.get(thread.id) ?? s.ephemeral.get(thread.id)
  const settings = live?.settings ?? s.store.getMeta('settings', thread.id)
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: metadata.forkedFromId ?? null,
    preview: thread.preview,
    name: thread.name,
    modelProvider: providerOf(settings?.model),
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
    canAcceptDirectInput: true,
    activePermissionProfile: settings?.preset ?? ':workspace',
    status: live?.projection.status() ?? { type: 'idle' },
    // OpenCode 的会话存在它自己的数据库里，不是 Codex rollout，不交给桌面读取。
    path: null,
    cwd: thread.cwd,
    cliVersion: s.runtime.host?.version ?? versions.opencodeMinimum,
    source: thread.parentThreadId
      ? { subAgent: { thread_spawn: { parent_thread_id: thread.parentThreadId, depth: 1 } } }
      : 'appServer',
    parentThreadId: thread.parentThreadId,
    ephemeral: thread.ephemeral,
    gitInfo: null,
    // 子代理的会话：昵称和角色都是子代理的种类（OpenCode 没有另起的昵称）
    agentNickname: thread.agent,
    agentRole: thread.agent,
    turns,
    projectId: s.projects.projectId(thread.id),
    // 分组、置顶这些界面元数据照 dsh 入口原样带上
    ...metadata,
  }
}

// 带会话设置的应答（thread/start、thread/resume、thread/fork）和设置变了的通知。
export async function settings(s: OpencodeServer, live: LiveThread): Promise<any> {
  const { thread, turns } = live.projection
  const preset = live.settings.preset
  const { model, effort } = await s.turns.selection(live)
  const modelProvider = providerOf(model)
  return {
    thread: { ...envelope(s, thread, turns), modelProvider },
    model: model ?? '',
    modelProvider,
    cwd: thread.cwd,
    approvalPolicy: preset === ':danger-full-access' ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    sandbox: sandbox(preset, thread.cwd),
    sandboxPolicy: sandbox(preset, thread.cwd),
    activePermissionProfile: { id: preset, extends: null },
    permissions: preset,
    reasoningEffort: effort,
    collaborationMode: {
      mode: live.settings.plan ? 'plan' : 'default',
      settings: { model: model ?? '', reasoning_effort: effort, developer_instructions: null },
    },
  }
}
