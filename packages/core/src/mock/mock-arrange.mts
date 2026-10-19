// 模拟核心里“整理侧栏”那一组（真的那一份是 device/organize.mts）：工作区的增删改和排序，
// 把会话移到别的工作区，置顶，组的增删改和往里放东西。
// 行为照着真的核心（device/organize.mts）：做完之后工作区那张表整份换掉，会话各改各的；
// 另有一出“别的客户端也在整理这台设备”，给界面试“别处改了，这边不刷新也看得到”用。
import { ChannelError, type Clock, type Commands, type SidebarOp } from '../channel/protocol.mjs'
import { WIRES } from '../device/remote.mjs'
import { isAbsolutePath } from '../device/workspaces.mjs'
import type {
  DeviceView,
  SectionView,
  SessionSummary,
  SidebarView,
  WireColor,
  WorkspaceView,
} from '../model.mjs'
import { phrase } from '../phrase.mjs'

export interface MockOrganizeHost {
  clock: Clock
  /** 一步动作隔多久，演别处的动静时用 */
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  sidebar(deviceId: string): SidebarView | undefined
  /** 侧栏整份换了：订阅着的各方各拿一份新的快照 */
  replaced(deviceId: string): void
  /** 一批增量交给订阅着这台设备侧栏的各方 */
  emit(deviceId: string, ops: SidebarOp[]): void
  /** 演别处的动静时，别处新建的工作区叫什么 */
  elsewhereName: string
}

export interface MockOrganize {
  /** 是这一组的命令就做掉并返回结果；不是返回 undefined */
  command(name: string, params: unknown): unknown
  /**
   * 演一出“别的客户端整理了这台设备的侧栏”：过一会儿，这个会话被置顶了，还多出一个工作区。
   * 这边什么都没做，全靠增量跟上
   */
  elsewhere(deviceId: string, sessionId: string): void
  /** 这个会话建在这个工作区里合不合适：工作区在就用它，不在就按工作目录去认 */
  home(deviceId: string, workspaceId: string | undefined, cwd: string | null): string | null
}

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

export function createMockOrganize(host: MockOrganizeHost): MockOrganize {
  let seq = 0

  /** 能整理才往下走，和真的一样分两种说法：没连着，或者对面没有这组方法 */
  const sidebarOf = (deviceId: string): SidebarView => {
    const device = host.device(deviceId)
    const sidebar = host.sidebar(deviceId)
    if (!device || !sidebar) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没有连上')
    if (!device.organizable) {
      throw new ChannelError(
        'unsupported',
        '对面没有工作区这组方法',
        phrase('fault.organizeUnsupported'),
      )
    }
    return sidebar
  }

  const named = (value: unknown): string => {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!name) {
      throw new ChannelError('rejected', '工作区的名字不能是空的', phrase('fault.workspaceName'))
    }
    return name
  }

  const sectionNamed = (value: unknown): string => {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!name) throw new ChannelError('rejected', '组的名字不能是空的', phrase('fault.sectionName'))
    return name
  }

  const sectionOf = (sidebar: SidebarView, sectionId: string): SectionView => {
    const found = sidebar.sections.find((entry) => entry.id === sectionId)
    if (!found) throw new ChannelError('notFound', '这个组已经不在了')
    return found
  }

  const colored = (value: unknown): WireColor | null => {
    if (value == null) return null
    if (!WIRES.includes(value as WireColor)) throw new ChannelError('rejected', '没有这种线色')
    return value as WireColor
  }

  const workspaceOf = (sidebar: SidebarView, workspaceId: string): WorkspaceView => {
    const found = sidebar.workspaces.find((entry) => entry.id === workspaceId)
    if (!found) {
      throw new ChannelError('notFound', '这个工作区已经不在了', phrase('fault.workspaceGone'))
    }
    return found
  }

  const patchSession = (deviceId: string, sessionId: string, patch: Partial<SessionSummary>) => {
    const sidebar = host.sidebar(deviceId)
    const at = sidebar?.sessions.findIndex((entry) => entry.id === sessionId) ?? -1
    if (!sidebar || at < 0) throw new ChannelError('notFound', `没有这个会话：${sessionId}`)
    const next = { ...(sidebar.sessions[at] as SessionSummary), ...patch }
    sidebar.sessions[at] = next
    host.emit(deviceId, [{ op: 'session.upsert', session: next }])
  }

  /** 加一个工作区。还没有归属、工作目录又在它下面的会话跟着归进去（真的核心是按整张表重新认的） */
  const addWorkspace = (
    deviceId: string,
    sidebar: SidebarView,
    workspace: WorkspaceView,
  ): string => {
    sidebar.workspaces = [...sidebar.workspaces, workspace]
    sidebar.sessions = sidebar.sessions.map((session) =>
      session.workspaceId === null && workspace.roots.some((root) => within(root, session.cwd))
        ? { ...session, workspaceId: workspace.id }
        : session,
    )
    host.replaced(deviceId)
    return workspace.id
  }

  return {
    command(name, params) {
      if (name === 'session.place') {
        const { deviceId, sessionId, place } = params as Commands['session.place']['params']
        const sidebar = sidebarOf(deviceId)
        const pinned = place === 'pinned'
        const section = place && place !== 'pinned' ? sectionOf(sidebar, place.sectionId) : null
        patchSession(deviceId, sessionId, {
          pinned,
          section,
          placedAt: pinned || section ? host.clock.now() : null,
        })
        return {}
      }
      if (name === 'session.move') {
        const { deviceId, sessionId, workspaceId } = params as Commands['session.move']['params']
        workspaceOf(sidebarOf(deviceId), workspaceId)
        patchSession(deviceId, sessionId, { workspaceId })
        return {}
      }
      if (name === 'workspace.create') {
        const {
          deviceId,
          name: given,
          root,
          color,
        } = params as Commands['workspace.create']['params']
        const sidebar = sidebarOf(deviceId)
        const path = typeof root === 'string' ? root.trim() : ''
        if (!isAbsolutePath(path)) {
          throw new ChannelError(
            'rejected',
            '工作区的目录要写完整的路径',
            phrase('fault.workspaceRoot'),
          )
        }
        const workspace: WorkspaceView = {
          id: `ws${++seq}`,
          name: named(given),
          roots: [path],
          color: colored(color),
          pinned: false,
          sectionId: null,
        }
        return { workspaceId: addWorkspace(deviceId, sidebar, workspace) }
      }
      if (name === 'workspace.update') {
        const {
          deviceId,
          workspaceId,
          name: given,
          color,
          pinned,
          sectionId,
        } = params as Commands['workspace.update']['params']
        const sidebar = sidebarOf(deviceId)
        const before = workspaceOf(sidebar, workspaceId)
        if (sectionId) sectionOf(sidebar, sectionId)
        // 置顶和进组只能有一样，和真的一样（device/workspaces.mts 的 metadataPatch）
        const next: WorkspaceView = {
          ...before,
          ...(given === undefined ? {} : { name: named(given) }),
          ...(color === undefined ? {} : { color: colored(color) }),
          ...(pinned === undefined ? {} : { pinned, ...(pinned ? { sectionId: null } : {}) }),
          ...(sectionId === undefined
            ? {}
            : { sectionId, ...(sectionId ? { pinned: false } : {}) }),
        }
        sidebar.workspaces = sidebar.workspaces.map((entry) => (entry === before ? next : entry))
        host.replaced(deviceId)
        return {}
      }
      if (name === 'workspace.move') {
        const { deviceId, workspaceId, before } = params as Commands['workspace.move']['params']
        const sidebar = sidebarOf(deviceId)
        const moved = workspaceOf(sidebar, workspaceId)
        const rest = sidebar.workspaces.filter((entry) => entry !== moved)
        const at = before == null ? -1 : rest.findIndex((entry) => entry.id === before)
        sidebar.workspaces =
          at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)]
        host.replaced(deviceId)
        return {}
      }
      if (name === 'workspace.delete') {
        const { deviceId, workspaceId } = params as Commands['workspace.delete']['params']
        const sidebar = sidebarOf(deviceId)
        const gone = workspaceOf(sidebar, workspaceId)
        sidebar.workspaces = sidebar.workspaces.filter((entry) => entry !== gone)
        // 只删这条记录：里面的会话都还在，回到“没有工作区”那一组
        sidebar.sessions = sidebar.sessions.map((session) =>
          session.workspaceId === workspaceId ? { ...session, workspaceId: null } : session,
        )
        host.replaced(deviceId)
        return {}
      }
      if (name === 'section.create') {
        const { deviceId, name: given } = params as Commands['section.create']['params']
        const sidebar = sidebarOf(deviceId)
        const section: SectionView = { id: `sec${++seq}`, name: sectionNamed(given) }
        sidebar.sections = [...sidebar.sections, section]
        host.replaced(deviceId)
        return { sectionId: section.id }
      }
      if (name === 'section.rename') {
        const { deviceId, sectionId, name: given } = params as Commands['section.rename']['params']
        const sidebar = sidebarOf(deviceId)
        const renamed = { ...sectionOf(sidebar, sectionId), name: sectionNamed(given) }
        sidebar.sections = sidebar.sections.map((entry) =>
          entry.id === sectionId ? renamed : entry,
        )
        // 会话对象上带着组的名字，跟着变
        sidebar.sessions = sidebar.sessions.map((session) =>
          session.section?.id === sectionId ? { ...session, section: renamed } : session,
        )
        host.replaced(deviceId)
        return {}
      }
      if (name === 'section.delete') {
        const { deviceId, sectionId } = params as Commands['section.delete']['params']
        const sidebar = sidebarOf(deviceId)
        sectionOf(sidebar, sectionId)
        sidebar.sections = sidebar.sections.filter((entry) => entry.id !== sectionId)
        // 里面的会话、工作区都放出来
        sidebar.sessions = sidebar.sessions.map((session) =>
          session.section?.id === sectionId
            ? { ...session, section: null, placedAt: null }
            : session,
        )
        sidebar.workspaces = sidebar.workspaces.map((entry) =>
          entry.sectionId === sectionId ? { ...entry, sectionId: null } : entry,
        )
        host.replaced(deviceId)
        return {}
      }
      if (name === 'workspace.candidates') {
        const { deviceId } = params as Commands['workspace.candidates']['params']
        const sidebar = host.sidebar(deviceId)
        if (!sidebar) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
        const loose = sidebar.sessions
          .filter((session) => session.workspaceId === null && isAbsolutePath(session.cwd))
          .sort((a, b) => b.updatedAt - a.updatedAt)
        return { roots: [...new Set(loose.map((session) => session.cwd))] }
      }
      return undefined
    },

    elsewhere(deviceId, sessionId) {
      const device = host.device(deviceId)
      if (!device?.organizable) return
      host.clock.setTimer(
        () => {
          const sidebar = host.sidebar(deviceId)
          if (!sidebar) return
          if (sidebar.sessions.some((entry) => entry.id === sessionId)) {
            patchSession(deviceId, sessionId, {
              pinned: true,
              section: null,
              placedAt: host.clock.now(),
            })
          }
          addWorkspace(deviceId, sidebar, {
            id: `ws${++seq}`,
            name: host.elsewhereName,
            roots: ['/srv/elsewhere'],
            color: 'orange',
            pinned: false,
            sectionId: null,
          })
        },
        Math.max(host.stepMs * 10, 1),
      )
    },

    home(deviceId, workspaceId, cwd) {
      const workspaces = host.sidebar(deviceId)?.workspaces ?? []
      if (workspaceId && workspaces.some((entry) => entry.id === workspaceId)) return workspaceId
      return workspaces.find((entry) => entry.roots.includes(cwd ?? ''))?.id ?? null
    },
  }
}
