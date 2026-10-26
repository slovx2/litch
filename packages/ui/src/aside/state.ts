// 侧聊（从眼前会话临时分出的一段对话，对面的临时分叉）在界面里的状态：每个会话同时一个，按“设备:主会话”记在内存里。
// 侧聊一直开着（订阅着）直到人关掉它：切会话、换侧面板的标签、收起面板都不放手，回来接着聊；
// 关掉、重开应用就没了（对面没人订阅一阵后把它卸载）。这个文件不画东西，侧面板的标签登记表也要引它。
import { keys, type TurnView } from '@litch/core'
import { useSyncExternalStore } from 'react'
import type { Services } from '../app/services.tsx'
import { prefillDraft } from '../composer/drafts.ts'
import { showSideTab } from '../side/side.ts'

export const ASIDE_TAB = 'aside'

export interface AsideState {
  /** 侧聊会话的标识。正在分叉时是 null */
  sessionId: string | null
  /** 第一次载入时已经在里面的回合：从主会话带过来的上下文，对话里不画。还没载入是 null */
  inherited: readonly string[] | null
  /** 分叉没成：为什么（核心给的失败） */
  failure: unknown
}

type Entry = AsideState & {
  /** 放掉订阅、不再看回合 */
  release: (() => void) | null
}

const keyOf = (deviceId: string, parentId: string) => `${deviceId}:${parentId}`

const entries = new Map<string, Entry>()
let version = 0
const listeners = new Set<() => void>()

const publish = () => {
  version++
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 这个会话的侧聊。没有是 null */
export function useAside(deviceId: string, parentId: string | null): AsideState | null {
  useSyncExternalStore(subscribe, () => version)
  return parentId === null ? null : (entries.get(keyOf(deviceId, parentId)) ?? null)
}

/** 选中的文字写成引用块：每行前面加 “> ”，后面空一行，好接着打问题 */
export const quoteBlock = (quote: string): string =>
  `${quote
    .trim()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')}\n\n`

/** 侧聊输入框的草稿键（和普通会话的一样） */
const draftOf = (deviceId: string, sessionId: string) => `${deviceId}:${sessionId}`

/**
 * 开侧聊（侧面板的“开始侧聊”、选字浮层的“侧聊”）：打开侧面板的“侧聊”标签；还没有就从主会话分一个。
 * quote：选中的文字，作为引用块放进侧聊的输入框（不发）。已经有侧聊时引用放进它的输入框
 */
export function startAside(
  services: Services,
  deviceId: string,
  parentId: string,
  quote?: string,
): void {
  showSideTab(ASIDE_TAB)
  const key = keyOf(deviceId, parentId)
  const current = entries.get(key)
  if (current && !current.failure) {
    // 还在分叉的，引用等分好了再放
    if (quote && current.sessionId)
      prefillDraft(draftOf(deviceId, current.sessionId), quoteBlock(quote), [])
    else if (quote) pendingQuotes.set(key, quote)
    return
  }
  const entry: Entry = { sessionId: null, inherited: null, failure: null, release: null }
  entries.set(key, entry)
  if (quote) pendingQuotes.set(key, quote)
  publish()
  services.channel.command('session.sideChat', { deviceId, sessionId: parentId }).then(
    ({ sessionId }) => {
      // 分叉途中被关掉了：分出来的不要了，对面没人订阅一阵就会扔掉
      if (entries.get(key) !== entry) return
      entry.sessionId = sessionId
      entry.release = hold(services, deviceId, sessionId, (inherited) => {
        entry.inherited = inherited
        publish()
      })
      const waiting = pendingQuotes.get(key)
      pendingQuotes.delete(key)
      if (waiting) prefillDraft(draftOf(deviceId, sessionId), quoteBlock(waiting), [])
      publish()
    },
    (failure: unknown) => {
      if (entries.get(key) !== entry) return
      pendingQuotes.delete(key)
      entry.failure = failure
      publish()
    },
  )
}

/** 分叉还没好时送来的引用：分好了再放进输入框 */
const pendingQuotes = new Map<string, string>()

/**
 * 开着侧聊会话（订阅），第一次载入时记下已有的回合（从主会话带来的）。返回放手的函数
 */
function hold(
  services: Services,
  deviceId: string,
  sessionId: string,
  loaded: (inherited: readonly string[]) => void,
): () => void {
  const { replica } = services
  const close = replica.openSession(deviceId, sessionId)
  const turnsKey = keys.turnIds(deviceId, sessionId)
  let stop: (() => void) | null = null
  const look = () => {
    const turnIds = replica.store.get<string[]>(turnsKey)
    if (!turnIds) return
    stop?.()
    stop = null
    loaded(turnIds)
  }
  stop = replica.store.subscribe(turnsKey, look)
  look()
  return () => {
    stop?.()
    close()
  }
}

/** 侧聊里有没有说过话（有回合不是从主会话带来的） */
export function asideSpoke(services: Services, deviceId: string, aside: AsideState): boolean {
  if (!aside.sessionId || !aside.inherited) return false
  const turnIds = services.replica.store.get<string[]>(keys.turnIds(deviceId, aside.sessionId))
  return (turnIds ?? []).some((id) => !aside.inherited?.includes(id))
}

/** 关掉侧聊：回合在跑就先停，然后放手。对面没人订阅一阵后就把它扔了，找不回来 */
export function closeAside(services: Services, deviceId: string, parentId: string): void {
  const key = keyOf(deviceId, parentId)
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  pendingQuotes.delete(key)
  const { sessionId, release } = entry
  if (sessionId) {
    const { store } = services.replica
    const last = store.get<string[]>(keys.turnIds(deviceId, sessionId))?.at(-1)
    const turn = last ? store.get<TurnView>(keys.turn(deviceId, sessionId, last)) : undefined
    if (turn?.status === 'running') {
      // 停了再放手：放手时回合还在跑的话，核心会一直留着它
      services.channel
        .command('session.interrupt', { deviceId, sessionId })
        .catch(() => {})
        .finally(() => release?.())
    } else release?.()
  }
  publish()
}

/** 新侧聊：关掉现在这个，从主会话最新的地方再分一个 */
export function renewAside(services: Services, deviceId: string, parentId: string): void {
  closeAside(services, deviceId, parentId)
  startAside(services, deviceId, parentId)
}

/** 把侧聊里选中的文字带回主会话：作为引用块放进主会话的输入框（不发） */
export function quoteToParent(deviceId: string, parentId: string, quote: string): void {
  prefillDraft(draftOf(deviceId, parentId), quoteBlock(quote), [])
}
