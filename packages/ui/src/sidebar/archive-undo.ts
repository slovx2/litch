// 归档之后的“撤销”：归档成了就出一条短暂的提示，点一下把它恢复回来。
// 提示还在的时候又归档了别的，并成同一条（“已归档 3 个对话”），撤销是把这几个一起恢复：
// 一个一条地叠起来，连着归档几个就会盖住半个对话区，也分不清哪条对哪个。
// 提示上说的会话要是已经在别处被恢复或者删掉了（比如在“已归档对话”那一页里），就从这条提示里去掉。
import {
  type CoreChannel,
  type KeyedStore,
  keys,
  type SessionSummary,
  type Text,
} from '@litch/core'
import { reasonOf } from '../app/errors.ts'
import { dismissToast, showToast } from '../app/toasts.tsx'

export interface Shelved {
  deviceId: string
  sessionId: string
  title: Text
  /** 归档的时候它正开着：撤销之后回到它 */
  reselect: boolean
}

interface Deps {
  channel: CoreChannel
  store: KeyedStore
  /** 撤销之后回到那个会话 */
  select(where: Shelved): void
}

const TOAST = 'archived'
const FAILED = 'archive-undo-failed'
/** 提示留多久。够看清是哪个、再去点撤销 */
const LIFE_MS = 6000

/** 提示上现在说的是哪几个 */
let batch: Shelved[] = []
/** 盯着这几个会话有没有在别处被恢复、被删掉：各自的停止函数 */
let watches: (() => void)[] = []

const unwatch = () => {
  for (const stop of watches) stop()
  watches = []
}

/** 这个会话现在还是“归档着”的吗：侧栏里没有它；已归档的那张表取过的话，表里有它 */
function stillShelved(store: KeyedStore, { deviceId, sessionId }: Shelved): boolean {
  if (store.get(keys.summary(deviceId, sessionId))) return false
  const shelved = store.get<SessionSummary[] | null>(keys.archived(deviceId))
  return !shelved || shelved.some((summary) => summary.id === sessionId)
}

function undo(deps: Deps): void {
  const items = batch
  batch = []
  unwatch()
  dismissToast(TOAST)
  dismissToast(FAILED)
  void Promise.allSettled(
    items.map(({ deviceId, sessionId }) =>
      deps.channel.command('session.unarchive', { deviceId, sessionId }),
    ),
  ).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
      // 没恢复成的还在“已归档对话”里，告诉用户去哪再试。这一条不自己消失
      const first = failures[0]?.reason
      showToast({
        id: FAILED,
        tone: 'err',
        lifeMs: 0,
        text: (t) => t('undo.failed', { count: failures.length, reason: reasonOf(first, t) }),
      })
      return
    }
    const only = items.length === 1 ? items[0] : undefined
    if (only?.reselect) deps.select(only)
  })
}

/** 按现在的 batch 把提示重新摆一遍；一个都不剩就收起 */
function present(deps: Deps): void {
  unwatch()
  const items = batch
  const first = items[0]
  if (!first) {
    dismissToast(TOAST)
    return
  }
  const prune = () => {
    if (batch !== items) return
    const kept = items.filter((entry) => stillShelved(deps.store, entry))
    if (kept.length === items.length) return
    batch = kept
    present(deps)
  }
  for (const entry of items) {
    watches.push(deps.store.subscribe(keys.summary(entry.deviceId, entry.sessionId), prune))
  }
  for (const deviceId of new Set(items.map((entry) => entry.deviceId))) {
    watches.push(deps.store.subscribe(keys.archived(deviceId), prune))
  }
  showToast({
    id: TOAST,
    lifeMs: LIFE_MS,
    text: (t) =>
      items.length === 1
        ? t('undo.archived', { title: t.text(first.title) })
        : t('undo.archivedMany', { count: items.length }),
    action: {
      label: (t) => t(items.length === 1 ? 'undo.action' : 'undo.actionAll'),
      run: () => undo(deps),
    },
    // 提示没了就不能撤销了：下一次归档从头数
    onGone() {
      if (batch !== items) return
      batch = []
      unwatch()
    },
  })
}

/** 一个会话刚归档成了：出（或者更新）那条可以撤销的提示 */
export function offerUndo(entry: Shelved, deps: Deps): void {
  const same = (other: Shelved) =>
    other.deviceId === entry.deviceId && other.sessionId === entry.sessionId
  batch = [...batch.filter((other) => !same(other) && stillShelved(deps.store, other)), entry]
  present(deps)
}
