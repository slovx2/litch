// 本机整理在核心里的那一份：核心是唯一的写入者（桌面上核心住在工具进程里，所有窗口共用；手机上只有一个），
// 命令一条一条做，存盘成功才算数，然后把新的一份推给所有订阅的窗口。文件怎么存由外壳给（OrganizerStore）。
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { phrase } from '../phrase.mjs'
import { applyOrganizer, type OrganizerAction, OrganizerRefusal } from './actions.mjs'
import {
  emptyOrganizer,
  type LocalGroup,
  type OrganizerFile,
  type OrganizerLoad,
  type PinRef,
} from './file.mjs'

/** 外壳给的存储。读写都是同步的；写失败就抛（原来那一份要留着） */
export interface OrganizerStore {
  load(): OrganizerLoad
  save(file: OrganizerFile): void
}

/** 界面看到的本机整理（organizer 主题的快照，副本里是 keys.organizer） */
export interface OrganizerView {
  /** ok：正常；corrupt、newer：文件坏了、来自更新的版本，整理停用，原文件不动 */
  status: 'ok' | 'corrupt' | 'newer'
  revision: number
  groups: LocalGroup[]
  pinOrder: PinRef[]
  folds: Record<string, boolean>
}

export type OrganizerOp = { op: 'organizer.set'; view: OrganizerView }

export interface OrganizerHost {
  view(): OrganizerView
  apply(action: OrganizerAction): { revision: number; groupId?: string }
  subscribe(sink: HostSink): () => void
}

/** 没给存储（测试、单独跑的核心）：只记在内存里 */
export function memoryOrganizerStore(initial: OrganizerLoad = { kind: 'empty' }): OrganizerStore {
  let current = initial
  return {
    load: () => current,
    save(file) {
      current = { kind: 'ok', file }
    },
  }
}

export function createOrganizerHost(store: OrganizerStore, now: () => number): OrganizerHost {
  const loaded = store.load()
  const status: OrganizerView['status'] =
    loaded.kind === 'corrupt' ? 'corrupt' : loaded.kind === 'newer' ? 'newer' : 'ok'
  let file: OrganizerFile = loaded.kind === 'ok' ? loaded.file : emptyOrganizer()
  const sinks = new Set<HostSink>()
  let counter = 0
  const view = (): OrganizerView => ({
    status,
    revision: file.revision,
    groups: file.groups,
    pinOrder: file.pinOrder,
    folds: file.folds,
  })
  /** 本机组的标识：只要在这份文件里不重复 */
  const newId = (): string => {
    for (;;) {
      const id = `g${now().toString(36)}${(counter++).toString(36)}`
      if (!file.groups.some((group) => group.id === id)) return id
    }
  }
  return {
    view,
    apply(action) {
      if (status === 'corrupt')
        throw new ChannelError('rejected', '本机整理文件已损坏', phrase('fault.organizerBlocked'))
      if (status === 'newer')
        throw new ChannelError('rejected', '本机整理文件版本更高', phrase('fault.organizerNewer'))
      let next: OrganizerFile
      let created: string | undefined
      try {
        next = applyOrganizer(file, action, () => {
          created = newId()
          return created
        })
      } catch (error) {
        if (!(error instanceof OrganizerRefusal)) throw error
        if (error.reason === 'conflict')
          throw new ChannelError('conflict', error.message, phrase('fault.organizerConflict'))
        if (error.reason === 'notFound')
          throw new ChannelError('notFound', error.message, phrase('fault.localGroupGone'))
        throw new ChannelError(
          'invalid',
          error.message,
          action.type === 'group.create' || action.type === 'group.rename'
            ? phrase('fault.localGroupName')
            : undefined,
        )
      }
      if (next === file) return { revision: file.revision }
      try {
        store.save(next)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new ChannelError(
          'internal',
          `本机整理未能保存：${reason}`,
          phrase('fault.organizerSave', { reason }),
        )
      }
      file = next
      const op: OrganizerOp = { op: 'organizer.set', view: view() }
      for (const sink of [...sinks]) sink.delta([op])
      return created ? { revision: file.revision, groupId: created } : { revision: file.revision }
    },
    subscribe(sink) {
      sink.snapshot(view())
      sinks.add(sink)
      return () => {
        sinks.delete(sink)
      }
    },
  }
}
