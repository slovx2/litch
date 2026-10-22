// 整理侧栏：工作区的增删改和排序，把会话移到别的工作区，置顶和取消置顶，组（自定义分区）的增删改和往里放东西。
// 用的都是 Codex 协议里现成的方法（project/*、thread/metadata/update、threadSection/*、thread/section/move）。
// 工作区的置顶、所在的组协议里没有，记在项目的 metadata 里（workspaces.mts 的 metadataPatch）。
// 对面是设备服务时这些数据存在设备层、跨 harness；对面是单个入口时存在那个引擎自己那里。
//
// 规矩：
// - 对面成了之后这边自己先改，不等通知：通知不一定发给提出请求的这条连接，再来一遍也是幂等的。
// - 工作区变了之后整份重新取一遍：会话归到哪个工作区是按整张表算的（见 workspaces.mts），不逐条去改。
// - 别处（另一条连接）做的改动靠通知跟上，在 device.mts 的路由表里。
import {
  type ClientRequests,
  PINNED_SECTION_ID,
  type Project,
  type Thread,
} from '../../../protocol/src/index.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import type { SectionView, WireColor } from '../model.mjs'
import { phrase } from '../phrase.mjs'
import { isAbsolutePath, metadataPatch, type WorkspaceMarks } from './workspaces.mjs'

export interface OrganizeHost {
  online(): boolean
  /** 对面有没有“项目”这组方法。还不知道（没对过账）也算没有 */
  capable(): boolean
  request<M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 把对面回的错误换成给人看的 */
  fail(error: unknown): ChannelError
  /** 现在的项目，协议里的原样 */
  projects(): readonly Project[]
  /** 现在的组 */
  sections(): readonly SectionView[]
  /** 重新取一遍工作区和组，侧栏整份换掉 */
  reload(): Promise<void>
  /** 会话目录里的这个会话。没有就是 undefined */
  thread(sessionId: string): Thread | undefined
  /** 会话的元数据换成这一份 */
  put(thread: Thread): void
  now(): number
}

export interface Organizer {
  /** 加一个工作区：起个名字，指一个目录。返回它的标识 */
  createWorkspace(input: { name: string; root: string; color?: WireColor | null }): Promise<string>
  /** 改名字、换颜色、置顶、放进组或拿出来。没给的不动；颜色、组给 null 是去掉 */
  updateWorkspace(workspaceId: string, patch: { name?: string } & WorkspaceMarks): Promise<void>
  /** 调顺序：挪到 before 这个工作区前面；null 是挪到最后 */
  moveWorkspace(workspaceId: string, before: string | null): Promise<void>
  /** 删掉这条记录。里面的会话、磁盘上的目录都不动 */
  deleteWorkspace(workspaceId: string): Promise<void>
  /** 把会话归到另一个工作区 */
  moveSession(sessionId: string, workspaceId: string): Promise<void>
  /** 置顶（pinned），放进一个组，或者从置顶、从它所在的组里拿出来（null） */
  placeSession(sessionId: string, place: SessionPlace): Promise<void>
  /** 建一个组。返回它的标识 */
  createSection(name: string): Promise<string>
  /** 给组改名 */
  renameSection(sectionId: string, name: string): Promise<void>
  /** 删掉一个组：里面的会话、工作区都放出来，不删它们 */
  deleteSection(sectionId: string): Promise<void>
}

/** 会话放到哪：置顶、某个组，null 是从置顶、从组里拿出来 */
export type SessionPlace = 'pinned' | { sectionId: string } | null

const NAME_MAX = 200

export function createOrganizer(host: OrganizeHost): Organizer {
  let seq = 0

  const ready = () => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
    if (!host.capable()) {
      throw new ChannelError(
        'unsupported',
        '对面没有工作区这组方法',
        phrase('fault.organizeUnsupported'),
      )
    }
  }

  const guarded = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw host.fail(error)
    }
  }

  const named = (value: string): string => {
    const name = value.trim()
    if (!name || name.length > NAME_MAX) {
      throw new ChannelError('rejected', '工作区的名字不能是空的', phrase('fault.workspaceName'))
    }
    return name
  }

  const sectionNamed = (value: string): string => {
    const name = value.trim()
    if (!name || name.length > NAME_MAX) {
      throw new ChannelError('rejected', '组的名字不能是空的', phrase('fault.sectionName'))
    }
    return name
  }

  /** 要改的这个工作区的原样。这边没有（别处刚建的）就先重新取一遍；还没有就是已经不在了 */
  const find = async (workspaceId: string): Promise<Project> => {
    const known = () => host.projects().find((project) => project.id === workspaceId)
    let project = known()
    if (!project) {
      await host.reload()
      project = known()
    }
    if (!project) {
      throw new ChannelError('notFound', '这个工作区已经不在了', phrase('fault.workspaceGone'))
    }
    return project
  }

  return {
    async createWorkspace({ name, root, color }) {
      ready()
      const path = root.trim()
      if (!isAbsolutePath(path)) {
        throw new ChannelError(
          'rejected',
          '工作区的目录要写完整的路径',
          phrase('fault.workspaceRoot'),
        )
      }
      const metadata = color ? metadataPatch({ metadata: {} }, { color }) : undefined
      const { project } = await guarded(() =>
        host.request('project/create', {
          name: named(name),
          roots: [{ path }],
          ...(metadata ? { metadata } : {}),
          // 请求重发时对面凭它认出是同一次，不会建出两个
          idempotencyKey: `litch-${host.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2)}`,
        }),
      )
      await host.reload()
      return project.id
    },

    async updateWorkspace(workspaceId, patch) {
      ready()
      const project = await find(workspaceId)
      const name = patch.name === undefined ? undefined : named(patch.name)
      const { name: _name, ...marks } = patch
      const metadata = metadataPatch(project, marks)
      if (name === undefined && metadata === undefined) return
      await guarded(() =>
        host.request('project/update', {
          projectId: workspaceId,
          ...(name === undefined ? {} : { name }),
          ...(metadata === undefined ? {} : { metadata }),
        }),
      )
      await host.reload()
    },

    async moveWorkspace(workspaceId, before) {
      ready()
      await guarded(() =>
        host.request('project/move', { projectId: workspaceId, beforeProjectId: before }),
      )
      await host.reload()
    },

    async deleteWorkspace(workspaceId) {
      ready()
      await guarded(() => host.request('project/delete', { projectId: workspaceId }))
      await host.reload()
    },

    async moveSession(sessionId, workspaceId) {
      ready()
      const { thread } = await guarded(() =>
        host.request('thread/metadata/update', { threadId: sessionId, projectId: workspaceId }),
      )
      // 归档着的会话不在目录里：不把它放回列表
      if (host.thread(sessionId)) host.put(thread)
    },

    async placeSession(sessionId, place) {
      ready()
      const sectionId =
        place === null ? null : place === 'pinned' ? PINNED_SECTION_ID : place.sectionId
      await guarded(() => host.request('thread/section/move', { threadId: sessionId, sectionId }))
      const thread = host.thread(sessionId)
      if (!thread) return
      // 置顶那个分区的名字没人看；组的名字取这边知道的
      const name = host.sections().find((entry) => entry.id === sectionId)?.name ?? ''
      host.put({
        ...thread,
        section: sectionId === null ? null : { id: sectionId, name, appearance: null },
        sectionEnteredAt: sectionId === null ? null : Math.floor(host.now() / 1000),
      })
    },

    async createSection(name) {
      ready()
      const { section } = await guarded(() =>
        host.request('threadSection/create', { name: sectionNamed(name) }),
      )
      await host.reload()
      return section.id
    },

    async renameSection(sectionId, name) {
      ready()
      await guarded(() =>
        host.request('threadSection/update', { sectionId, name: sectionNamed(name) }),
      )
      await host.reload()
    },

    async deleteSection(sectionId) {
      ready()
      await guarded(() => host.request('threadSection/delete', { sectionId }))
      // 里面的会话由设备放出来（各有一条通知）；工作区上记着的组不用去改，组不在了就当没放（workspaces.mts）
      await host.reload()
    },
  }
}

/**
 * 加工作区时可以直接挑的目录：还没归进任何工作区的会话的工作目录，最近用过的在前，不重复。
 * 客户端看不到设备上的文件系统（远程设备更是），所以候选只能从已有的会话里来；都不合适就手写路径。
 */
export function looseDirectories<T extends Pick<Thread, 'cwd' | 'updatedAt'>>(
  threads: Iterable<T>,
  placed: (thread: T) => boolean,
  limit = 12,
): string[] {
  const latest = new Map<string, number>()
  for (const thread of threads) {
    const cwd = thread.cwd
    if (!cwd || !isAbsolutePath(cwd) || placed(thread)) continue
    latest.set(cwd, Math.max(latest.get(cwd) ?? 0, thread.updatedAt ?? 0))
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cwd]) => cwd)
}
