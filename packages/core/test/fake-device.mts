// 测试用的假聚合面：照设备进程（packages/device）的路由规则和错误形状应答，背后是几个假的 harness。
// 只做客户端会碰到的那些：runtime/info、合并的会话列表（翻页、重复、没包含进来的 harness）、
// 按会话归属和按 harness 参数路由、聚合面自己的几种错误、会话对象上的 harness、
// 各个 harness 的声明，以及设备级的工作区与置顶（声明了 deviceWorkspaces 才有）。
import {
  type HarnessDeclaration,
  type Model,
  PINNED_SECTION_ID,
  type Project,
  type Thread,
} from '../../protocol/src/index.mjs'
import { type Handler, RpcFailure } from './fake-server.mjs'
import { project, thread, turn } from './fixtures.mjs'

export interface FakeHarness {
  id: string
  displayName: string
  badge: string
  version: string | null
  /** 不可用的原因。可用就是 null */
  down: { kind: string; message: string } | null
  threads: Thread[]
  archived: Thread[]
  models: Model[]
  /** 这个引擎不认识的方法：转过去之后它自己回“方法不存在” */
  lacks: string[]
  /**
   * 像原生 codex 那样不认识的方法：聚合面替它回“不支持”，data 里写着原因、方法和是哪个 harness
   */
  refuses: string[]
  /** 它的结构化声明（认识的扩展、能力位、权限预设）。旧版的适配器没有，是 null */
  declaration: Pick<HarnessDeclaration, 'extensions' | 'features' | 'permissionPresets'> | null
  /** 列表问到它的时候它回的错（问了没成）。平时是 null */
  listFailure: string | null
}

export function harness(id: string, fields: Partial<FakeHarness> = {}): FakeHarness {
  return {
    id,
    displayName: id.toUpperCase(),
    badge: id.slice(0, 2).toUpperCase(),
    version: '1.0.0',
    down: null,
    threads: [],
    archived: [],
    models: [],
    lacks: [],
    refuses: [],
    declaration: null,
    listFailure: null,
    ...fields,
  }
}

export function model(id: string, fields: Partial<Model> = {}): Model {
  return {
    id,
    model: id,
    displayName: id,
    description: '',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    ...fields,
  } as Model
}

export interface FakeDevice {
  harnesses: FakeHarness[]
  /** 设备信息里声明的扩展。带上 deviceSettings 才算有设备配置接口 */
  extensions: string[]
  /**
   * 设备信息里的 service：在跑的那份设备服务的来历（deviceService 扩展）。
   * undefined 是不带这个字段：旧版的设备服务，或者设备进程刚起来、还没从主进程那里拿到
   */
  service: unknown
  /** 列表每页几条。小一点逼着客户端翻页 */
  pageSize: number
  /** 翻页时把上一页的最后一条再给一次：列表在翻页期间有变动时就会这样 */
  repeatAcrossPages: boolean
  /** 之后的 turn/start 回这个错。平时是 null */
  turnFailure: RpcFailure | null
  turnSeq: number
  threadSeq: number
  /** 设备级的工作区。extensions 里有 deviceWorkspaces 时这组方法才有 */
  projects: Project[]
  /** 设备层记的归属：会话 → 工作区 */
  assigned: Map<string, string>
  /** 设备层记的分区：会话 → 所在的分区和进去的时间 */
  placed: Map<string, { id: string; name: string; at: number }>
}

const fault = (code: number, message: string, data: Record<string, unknown>) =>
  new RpcFailure(code, message, data)

/** 设备服务声明一个 harness 时的形状 */
export const infoOf = (entry: FakeHarness) => ({
  id: entry.id,
  displayName: entry.displayName,
  badge: entry.badge,
  version: entry.version,
  engine: entry.id,
  available: entry.down === null,
  unavailable: entry.down,
  ...(entry.declaration ?? {}),
})

export function fakeDevice(harnesses: FakeHarness[]): {
  device: FakeDevice
  handlers: Record<string, Handler>
} {
  const device: FakeDevice = {
    harnesses,
    extensions: ['harness'],
    service: undefined,
    pageSize: 100,
    repeatAcrossPages: false,
    turnFailure: null,
    turnSeq: 0,
    threadSeq: 0,
    projects: [],
    assigned: new Map(),
    placed: new Map(),
  }

  /** 聚合面给出的会话对象：打上 harness；设备层记着的归属和分区盖在引擎自己的那一份上 */
  const stamp = (entry: FakeHarness, source: Thread, withTurns = true) => {
    const place = device.placed.get(source.id)
    return {
      ...source,
      ...(withTurns ? {} : { turns: [] }),
      ...(workspaces()
        ? {
            projectId: device.assigned.get(source.id) ?? null,
            section: place ? { id: place.id, name: place.name, appearance: null } : null,
            sectionEnteredAt: place?.at ?? null,
          }
        : {}),
      harness: entry.id,
    }
  }

  const workspaces = (): boolean => device.extensions.includes('deviceWorkspaces')

  const named = (id: unknown, method: string): FakeHarness => {
    if (typeof id !== 'string' || !id) {
      throw fault(-32601, `聚合面不支持 ${method}：要用 harness 参数指明发给谁`, {
        litch: 'unsupported',
        method,
      })
    }
    const entry = device.harnesses.find((item) => item.id === id)
    if (!entry) {
      throw fault(-32602, `这台设备上没有配置 ${id}`, { litch: 'unknownHarness', harness: id })
    }
    return entry
  }

  /** 转给这个 harness。它不可用就是聚合面自己回错；它不认识这个方法就是它回的“方法不存在” */
  const reach = (entry: FakeHarness, method: string): FakeHarness => {
    if (entry.down) {
      throw fault(-32050, `${entry.id} 现在不可用：${entry.down.message}`, {
        litch: 'harnessUnavailable',
        harness: entry.id,
        method,
      })
    }
    if (entry.lacks.includes(method)) throw new RpcFailure(-32601, `Method not found: ${method}`)
    if (entry.refuses.includes(method)) {
      throw fault(-32601, `${entry.id} 不支持 ${method}`, {
        litch: 'unsupported',
        method,
        harness: entry.id,
      })
    }
    return entry
  }

  /** 按会话归属找到它所在的 harness。可用的都不认识它时，说明哪些当时没问到 */
  const owning = (params: unknown, method: string): { entry: FakeHarness; found: Thread } => {
    const { threadId } = params as { threadId: string }
    for (const entry of device.harnesses) {
      const found = [...entry.threads, ...entry.archived].find((item) => item.id === threadId)
      if (found) return { entry: reach(entry, method), found }
    }
    const unavailable = device.harnesses.filter((item) => item.down).map((item) => item.id)
    throw fault(-32602, `没有找到会话 ${threadId}`, {
      litch: 'unknownThread',
      threadId,
      unavailable,
    })
  }

  const byThread =
    (method: string, run: (entry: FakeHarness, found: Thread, params: unknown) => unknown) =>
    (params: unknown) => {
      const { entry, found } = owning(params, method)
      return run(entry, found, params)
    }

  const byHarness =
    (method: string, run: (entry: FakeHarness, params: Record<string, unknown>) => unknown) =>
    (params: unknown) => {
      const fields = (params ?? {}) as Record<string, unknown>
      return run(reach(named(fields.harness, method), method), fields)
    }

  const unsupported = (method: string) => {
    throw fault(-32601, `聚合面不支持 ${method}`, { litch: 'unsupported', method })
  }

  /** 设备级的工作区那一组：设备声明了才有，否则和以前一样是“聚合面不支持” */
  const organized =
    (method: string, run: (fields: Record<string, unknown>) => unknown): Handler =>
    (params) => {
      if (!workspaces()) unsupported(method)
      return run((params ?? {}) as Record<string, unknown>)
    }

  const projectOf = (id: unknown): Project => {
    const found = device.projects.find((entry) => entry.id === id)
    if (!found) throw new RpcFailure(-32602, `没有这个工作区：${String(id)}`)
    return found
  }

  const renumber = () => {
    device.projects.forEach((entry, index) => {
      entry.position = index
    })
  }

  /** 不看 harness 可不可用：按归属找到会话（设备层的事，harness 不可用时也能做） */
  const located = (threadId: unknown): { entry: FakeHarness; found: Thread } => {
    for (const entry of device.harnesses) {
      const found = [...entry.threads, ...entry.archived].find((item) => item.id === threadId)
      if (found) return { entry, found }
    }
    throw fault(-32602, `没有找到会话 ${String(threadId)}`, { litch: 'unknownThread', threadId })
  }

  const handlers: Record<string, Handler> = {
    'runtime/info': () => ({
      device: {
        hostname: 'fake-host',
        os: 'macos',
        home: '/home/dev',
        version: '0.6.0',
        protocolVersion: '0.157.1',
        extensions: device.extensions,
        ...(device.service === undefined ? {} : { service: device.service }),
      },
      harnesses: device.harnesses.map(infoOf),
    }),
    'project/list': organized('project/list', () => ({ data: device.projects, nextCursor: null })),
    'project/create': organized('project/create', (fields) => {
      const [root] = fields.roots as { path: string }[]
      const created = {
        ...project(`p-${++device.threadSeq}`, String(fields.name), root?.path ?? ''),
        metadata: (fields.metadata ?? {}) as Record<string, string>,
      }
      device.projects.push(created)
      renumber()
      return { project: created }
    }),
    'project/update': organized('project/update', (fields) => {
      const found = projectOf(fields.projectId)
      if (typeof fields.name === 'string') found.name = fields.name
      // 协议里这一项是整份替换
      if (fields.metadata != null) found.metadata = fields.metadata as Record<string, string>
      return { project: found }
    }),
    'project/move': organized('project/move', (fields) => {
      const found = projectOf(fields.projectId)
      const rest = device.projects.filter((entry) => entry !== found)
      const at =
        fields.beforeProjectId == null
          ? -1
          : rest.findIndex((entry) => entry.id === fields.beforeProjectId)
      device.projects = at < 0 ? [...rest, found] : [...rest.slice(0, at), found, ...rest.slice(at)]
      renumber()
      return {}
    }),
    'project/delete': organized('project/delete', (fields) => {
      const found = projectOf(fields.projectId)
      device.projects = device.projects.filter((entry) => entry !== found)
      renumber()
      for (const [threadId, projectId] of device.assigned) {
        if (projectId === found.id) device.assigned.delete(threadId)
      }
      return {}
    }),
    // 归属记在设备层，但要它所属的 harness 认这个会话：harness 不可用时做不了
    'thread/metadata/update': organized('thread/metadata/update', (fields) => {
      const { entry, found } = owning(fields, 'thread/metadata/update')
      if (fields.projectId === '') device.assigned.delete(found.id)
      else if (typeof fields.projectId === 'string') {
        device.assigned.set(found.id, projectOf(fields.projectId).id)
      }
      return { thread: stamp(entry, found, false) }
    }),
    // 置顶和分区只是设备层的事：会话所属的 harness 不可用时也能做
    'thread/section/move': organized('thread/section/move', (fields) => {
      const { found } = located(fields.threadId)
      if (fields.sectionId === null) device.placed.delete(found.id)
      else if (fields.sectionId === PINNED_SECTION_ID) {
        device.placed.set(found.id, { id: PINNED_SECTION_ID, name: 'Pinned', at: 1_700_000_500 })
      } else throw new RpcFailure(-32602, '未知分组')
      return {}
    }),
    'thread/list': (params) => {
      const asked = params as { cursor?: string; archived?: boolean; harness?: string }
      const sources = asked.harness ? [named(asked.harness, 'thread/list')] : device.harnesses
      const skipped = sources.flatMap((entry) =>
        entry.down
          ? [{ harness: entry.id, reason: 'unavailable', message: entry.down.message }]
          : entry.listFailure
            ? [{ harness: entry.id, reason: 'failed', message: entry.listFailure }]
            : [],
      )
      const merged = sources
        .filter((entry) => !entry.down && !entry.listFailure)
        .flatMap((entry) =>
          (asked.archived ? entry.archived : entry.threads).map((item) =>
            stamp(entry, item, false),
          ),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const start = Number(asked.cursor ?? 0)
      // 重复的那一条：上一页的最后一条再给一次
      const from = device.repeatAcrossPages && start > 0 ? start - 1 : start
      const end = start + device.pageSize
      return {
        data: merged.slice(from, end),
        nextCursor: end < merged.length ? String(end) : null,
        backwardsCursor: null,
        skippedHarnesses: skipped,
      }
    },
    'thread/read': byThread('thread/read', (entry, found, params) => ({
      thread: stamp(entry, found, (params as { includeTurns?: boolean }).includeTurns === true),
    })),
    'thread/resume': byThread('thread/resume', (entry, found) => {
      if (entry.archived.includes(found)) throw new RpcFailure(-32600, 'thread is archived')
      return { thread: stamp(entry, found), model: entry.models[0]?.model ?? null }
    }),
    'thread/unsubscribe': byThread('thread/unsubscribe', () => ({ status: 'unsubscribed' })),
    'thread/name/set': byThread('thread/name/set', (_entry, found, params) => {
      found.name = (params as { name: string }).name
      return {}
    }),
    'thread/archive': byThread('thread/archive', (entry, found) => {
      entry.threads = entry.threads.filter((item) => item !== found)
      entry.archived.push(found)
      return {}
    }),
    'thread/unarchive': byThread('thread/unarchive', (entry, found) => {
      entry.archived = entry.archived.filter((item) => item !== found)
      entry.threads.push(found)
      return { thread: stamp(entry, found, false) }
    }),
    'thread/delete': byThread('thread/delete', (entry, found) => {
      entry.threads = entry.threads.filter((item) => item !== found)
      entry.archived = entry.archived.filter((item) => item !== found)
      return {}
    }),
    'thread/fork': byThread('thread/fork', (entry, found) => {
      const forked = thread({ id: `${entry.id}-fork-${++device.threadSeq}`, cwd: found.cwd })
      entry.threads.push(forked)
      return { thread: stamp(entry, forked) }
    }),
    'thread/compact/start': byThread('thread/compact/start', () => ({})),
    'turn/start': byThread('turn/start', () => {
      if (device.turnFailure) throw device.turnFailure
      return { turn: turn(`srv-${++device.turnSeq}`, [], { status: 'inProgress' }) }
    }),
    'turn/interrupt': byThread('turn/interrupt', () => ({})),
    'thread/start': byHarness('thread/start', (entry, fields) => {
      const created = thread({
        id: `${entry.id}-new-${++device.threadSeq}`,
        cwd: typeof fields.cwd === 'string' ? fields.cwd : '/home/dev',
      })
      entry.threads.push(created)
      // 新建时带的工作区是设备层的：聚合面摘下来自己记
      if (workspaces() && typeof fields.projectId === 'string') {
        device.assigned.set(created.id, projectOf(fields.projectId).id)
      }
      // 转给上游之前 harness 参数已经摘掉了：上游给回来的东西里只有聚合面打的那个 harness
      return { thread: stamp(entry, created), model: entry.models[0]?.model ?? null }
    }),
    'model/list': byHarness('model/list', (entry) => ({ data: entry.models, nextCursor: null })),
  }
  return { device, handlers }
}
