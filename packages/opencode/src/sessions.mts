import type { OcThread, Projection } from './projection.mjs'
import type { OpencodeServer, Preset, ThreadSettings } from './server.mjs'

// OpenCode 会话的清单、会话对象上的几样（名字、预览、归档）、适配器替会话记的设置。

// OpenCode 新会话的默认标题是“New session - 时间”（子会话是 Child session - ），它的模型起好标题之前一直是这个。
// 这不是谁起的名字，不当会话的名字（客户端没有名字时显示预览）。
// 分叉出来的会话标题是原标题加“ (fork #N)”：原标题是默认的，分叉的也当默认标题看
const DEFAULT_TITLE =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z( \(fork #\d+\))*$/
export const isDefaultTitle = (title: unknown): boolean =>
  typeof title !== 'string' || DEFAULT_TITLE.test(title)

const PRESETS: Record<string, Preset> = {
  ':read-only': ':read-only',
  ':workspace': ':workspace',
  ':danger-full-access': ':danger-full-access',
  readOnly: ':read-only',
  workspaceWrite: ':workspace',
  dangerFullAccess: ':danger-full-access',
  'read-only': ':read-only',
  'workspace-write': ':workspace',
  'danger-full-access': ':danger-full-access',
}

/** 请求参数里的权限档（permissions、旧的 sandbox 写法都认）；没给是 null */
export function presetFromParams(params: any): Preset | null {
  for (const value of [
    params?.permissions,
    params?.activePermissionProfile?.id,
    params?.sandboxPolicy?.type,
    params?.sandbox,
  ])
    if (typeof value === 'string' && PRESETS[value]) return PRESETS[value]
  return null
}

export class Sessions {
  private readonly server: OpencodeServer
  /** OpenCode 现有的会话，最近一次列清单记下的：会话号 → 会话对象 */
  known = new Map<string, OcThread>()

  constructor(server: OpencodeServer) {
    this.server = server
  }

  private meta(scope: string, id: string): any {
    return this.server.store.getMeta(scope, id)
  }

  /** OpenCode 的会话对象（Session.Info）转成线程摘要；previous 是打开着的那一份（预览沿用） */
  thread(info: any, previous?: OcThread): OcThread {
    const shown = this.meta('display', info.id)
    const title = String(info.title ?? '')
    return {
      id: String(info.id),
      cwd: String(info.directory ?? ''),
      title,
      name: isDefaultTitle(title) ? (this.meta('name', info.id)?.name ?? null) : title,
      preview: previous?.preview || shown?.preview || '',
      createdAt: Math.floor(Number(info.time?.created ?? Date.now()) / 1000),
      updatedAt: Math.floor(Number(info.time?.updated ?? Date.now()) / 1000),
      parentThreadId: typeof info.parentID === 'string' ? info.parentID : null,
      agent:
        typeof info.parentID === 'string' && typeof info.agent === 'string' && info.agent
          ? info.agent
          : null,
      ephemeral: false,
    }
  }

  /** 归档：适配器这边记的为准（OpenCode 只能归档、不能取消），没记过的看 OpenCode 自己归没归档 */
  archived(id: string): boolean {
    const marked = this.meta('thread', id)?.archived
    if (typeof marked === 'boolean') return marked
    return this.nativeArchived.has(id)
  }
  private readonly nativeArchived = new Set<string>()

  /**
   * 列 OpenCode 的会话（全部项目，GET /experimental/session，含归档的），记下来给项目存储用。
   * 没说过话的不列：标题还是默认的、适配器也没见过它的用户消息（没记过预览）的会话，
   * 多半是新建了没发消息就走开的（和上游不列没有预览的会话一样）。
   */
  async list(): Promise<OcThread[]> {
    const api = await this.server.api()
    const rows: any[] = []
    let cursor: number | undefined
    for (let page = 0; page < 20; page += 1) {
      const batch = await api.request<any[]>('GET', '/experimental/session', {
        query: { archived: true, limit: 500, cursor },
      })
      if (!Array.isArray(batch) || !batch.length) break
      rows.push(...batch)
      if (batch.length < 500) break
      cursor = Number(batch.at(-1)?.time?.updated)
    }
    this.known = new Map()
    this.nativeArchived.clear()
    const threads: OcThread[] = []
    for (const row of rows) {
      const thread = this.server.live.get(row.id)?.projection.thread ?? this.thread(row)
      this.known.set(thread.id, thread)
      if (row.time?.archived) this.nativeArchived.add(thread.id)
      if (isDefaultTitle(row.title) && !this.meta('display', row.id)) continue
      threads.push(thread)
    }
    return threads
  }

  /**
   * 适配器替会话记的设置（模型、强度、权限档、计划模式）。没记过的照 OpenCode 的记录来：
   * 模型和强度是最后一条用户消息用的（没有就是会话上记的），权限档是项目内，计划模式看最后一条用户消息的 agent。
   */
  settings(id: string, info: any, messages: any[] | null): ThreadSettings {
    const saved = this.meta('settings', id)
    if (saved) return saved
    const last = (Array.isArray(messages) ? messages : []).findLast(
      (entry) => entry?.info?.role === 'user',
    )?.info
    const model = last?.model?.providerID
      ? `${last.model.providerID}/${last.model.modelID}`
      : info?.model?.providerID
        ? `${info.model.providerID}/${info.model.id}`
        : null
    const effort = last?.model?.variant ?? info?.model?.variant ?? null
    const defaults = this.meta('config', 'defaults') ?? {}
    return {
      model,
      effort,
      preset: presetFromParams({ sandbox: defaults.sandbox_mode }) ?? ':workspace',
      plan: last?.agent === 'plan',
    }
  }

  saveSettings(id: string, settings: ThreadSettings): void {
    this.server.store.setMeta('settings', id, settings)
  }

  /** 会话打开着时把预览记下来：列清单时 OpenCode 给不出预览（要读整段消息才知道头一句话） */
  display(id: string, projection: Projection): void {
    const preview = projection.thread.preview
    if (!preview) return
    if (this.meta('display', id)?.preview !== preview)
      this.server.store.setMeta('display', id, { preview })
  }

  /** 客户端改的名字在 OpenCode 起好标题之前只记在适配器这边（见 protocol.mts 的 thread/name/set） */
  setLocalName(thread: OcThread, name: string): void {
    this.server.store.setMeta('name', thread.id, { name })
    thread.name = name
    this.server.notify(thread.id, 'thread/name/updated', { threadName: name })
  }

  /** session.updated：标题变了的话名字跟着变 */
  updated(info: any): void {
    if (!info?.id) return
    const live = this.server.live.get(info.id)
    const current = live?.projection.thread ?? this.known.get(info.id)
    const next = this.thread(info, current)
    if (current) {
      current.title = next.title
      current.updatedAt = Math.max(current.updatedAt, next.updatedAt)
      if (next.name !== current.name) {
        current.name = next.name
        if (live && next.name !== null)
          this.server.notify(info.id, 'thread/name/updated', { threadName: next.name })
      }
    }
    if (!live) this.known.set(info.id, next)
  }

  /** session.deleted（适配器自己删的，或者别处删的） */
  deleted(id: string): void {
    const live = this.server.live.get(id)
    this.known.delete(id)
    if (!live) return
    this.server.live.delete(id)
    this.server.requests.reject((threadId) => threadId === id, '会话已删除')
    this.server.notify(id, 'thread/deleted', {})
  }
}
