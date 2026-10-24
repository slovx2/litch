// 对话区的两档视图：精简（默认，步骤收成汇总行、回合结束整段过程收起）和详细（步骤组、条目、思考全展开，
// 回合结束不收）。在标题栏的会话菜单里切，按会话记在这台电脑的界面里（litch.transcriptView），不经核心。
// 只记切成了详细的那些会话，新会话、没记着的都是精简；记多了丢最早切的。
// 这个文件不碰页面上的元素，只管数和存取，好单独测。
import { useSyncExternalStore } from 'react'

export type TranscriptView = 'compact' | 'verbose'

const STORAGE_KEY = 'litch.transcriptView'
/** 最多记这么多个会话，再多丢最早切成详细的 */
export const VIEW_KEEP = 300

/** 存着的那一份读成“切成详细的会话”，先切的在前。认不出的一律丢掉 */
export function parseViews(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '{}') as { verbose?: unknown }
    if (!Array.isArray(parsed.verbose)) return []
    const keys = parsed.verbose.filter(
      (key): key is string => typeof key === 'string' && key !== '',
    )
    return [...new Set(keys)].slice(-VIEW_KEEP)
  } catch {
    return []
  }
}

/** 这个会话换成这一档之后的名单。刚切成详细的排到最后，超出上限丢最前面的 */
export function withView(
  list: readonly string[],
  sessionKey: string,
  view: TranscriptView,
): string[] {
  const rest = list.filter((key) => key !== sessionKey)
  return view === 'verbose' ? [...rest, sessionKey].slice(-VIEW_KEEP) : rest
}

function readSaved(): string[] {
  try {
    return parseViews(localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

let verbose = new Set(readSaved())
const listeners = new Set<() => void>()
/** 换档那一刻（页面还没重画）就要知道的：对话区要在这时盯住眼前那一行 */
const switchListeners = new Set<(sessionKey: string) => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const viewOf = (sessionKey: string): TranscriptView =>
  verbose.has(sessionKey) ? 'verbose' : 'compact'

/** 这个会话现在是哪一档 */
export const useTranscriptView = (sessionKey: string): TranscriptView =>
  useSyncExternalStore(subscribe, () => viewOf(sessionKey))

export function setTranscriptView(sessionKey: string, view: TranscriptView): void {
  if (viewOf(sessionKey) === view) return
  const next = withView([...verbose], sessionKey, view)
  for (const listener of switchListeners) listener(sessionKey)
  verbose = new Set(next)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ verbose: next }))
  } catch {
    // 记不下来不影响这一次
  }
  for (const listener of listeners) listener()
}

/** 换档之前先叫一声（还没重画）：对话区的滚动用它记下眼前那一行 */
export function onViewSwitch(listener: (sessionKey: string) => void): () => void {
  switchListeners.add(listener)
  return () => {
    switchListeners.delete(listener)
  }
}
