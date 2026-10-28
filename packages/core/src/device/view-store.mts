// 会话视图存在这台电脑上的那一份：重启应用、或者核心早已放掉的会话，再打开时先拿它摆出来（标着 stale，只读），
// 设备连上、整份历史拉完，核心的快照到了整份换掉。存在哪由外壳定（桌面端是用户数据目录下的文件），
// 手机端在自己的存储层做了同样的事（apps/mobile/src/core/view-cache.ts），不经这里。
import type { SessionView } from '../model.mjs'

/** 一台设备的会话视图存哪。存取失败不影响使用 */
export interface ViewStore {
  load(sessionId: string): SessionView | null
  /** 存一份（外壳自己裁、自己挑时机写，不阻塞调用方） */
  save(view: SessionView): void
  /** 会话删了、归档了：不留 */
  forget(sessionId: string): void
}

/** 存的时候最多留几个回合 */
export const VIEW_KEEP_TURNS = 40

/** 只留最近 turns 个回合和它们的条目；请求、排队清空（过时了会误导） */
export function trimView(view: SessionView, turns = VIEW_KEEP_TURNS): SessionView {
  const kept = view.turns.slice(-turns)
  const items: SessionView['items'] = {}
  for (const turn of kept)
    for (const id of turn.itemIds) {
      const item = view.items[id]
      if (item) items[id] = item
    }
  return { ...view, turns: kept, items, requests: [], queued: [] }
}

/**
 * 摆出来的旧视图：标 stale、不能发（live 为假，界面上回退、分叉这些都不出），等人答的请求和排队的消息不带
 */
export const staleView = (view: SessionView): SessionView => ({
  ...view,
  live: false,
  note: null,
  requests: [],
  queued: [],
  stale: true,
})

/** 读回来的视图：形状大致对得上才用（不对的当没存过）。外壳读文件后调它 */
export function checkView(value: unknown, deviceId: string, sessionId: string): SessionView | null {
  if (typeof value !== 'object' || value === null) return null
  const view = value as Partial<SessionView>
  if (view.deviceId !== deviceId || view.sessionId !== sessionId) return null
  if (!Array.isArray(view.turns) || typeof view.items !== 'object' || view.items === null)
    return null
  if (typeof view.harness !== 'string' || typeof view.settings !== 'object') return null
  return view as SessionView
}
