// 定时任务的一次运行在回合结束时会话里还有后台任务在跑（决 430）：运行照常算结束（task-run.mts），
// 跑它的那条内部连接留下来接着听这个会话：
//   - 引擎自己续跑的回合（turn/completed 带 litchOrigin backgroundTask）结束时，用那一回合最后的回答更新运行的摘要，
//     后台任务数换成这时还在跑的个数；
//   - 后台全部结束、引擎不会接着做的（原生 codex），把后台任务数清零；会接着做的等一会儿续跑的回合，等不到也收。
// 每次更新都把运行标成没看过。后台都结束了、超过回合时限、连接断了，就关掉连接。
import type { EngineLink } from './engine-link.mjs'
import { isObject } from './wire.mjs'

export interface FollowUpdate {
  /** 新的摘要；不带是不改 */
  summary?: string | null
  /** 这时还在跑的后台任务数 */
  backgroundTasks: number
}

export interface FollowHost {
  now(): number
  /** 最多盯多久（毫秒），用回合时限 */
  limitMs: number
  /** 全部结束、引擎会接着做时，等续跑的回合开始等多久 */
  settleMs: number
  backgroundRunning(threadId: string): number
  backgroundWakes(threadId: string): boolean
  summaryOf(text: string | null): string | null
  log(line: string): void
}

/** 盯着 link 上的 threadId，直到后台都结束。返回停下（会关掉连接） */
export function followBackground(
  host: FollowHost,
  link: EngineLink,
  threadId: string,
  update: (patch: FollowUpdate) => void,
): () => void {
  /** 还没结束的回合 → 它最后一条回答 */
  const turns = new Map<string, string | null>()
  let settle: NodeJS.Timeout | null = null
  let stopped = false
  let lastCount = host.backgroundRunning(threadId)

  const stop = () => {
    if (stopped) return
    stopped = true
    off()
    unclose()
    clearTimeout(limit)
    if (settle) clearTimeout(settle)
    link.close()
  }
  const report = (patch: FollowUpdate) => {
    lastCount = patch.backgroundTasks
    update(patch)
  }

  /** 看一眼还有没有在跑的：没有了、也没有回合在跑，就收尾 */
  const review = () => {
    if (stopped || host.backgroundRunning(threadId) > 0 || turns.size > 0) {
      if (settle && turns.size > 0) {
        clearTimeout(settle)
        settle = null
      }
      return
    }
    if (!host.backgroundWakes(threadId)) {
      if (lastCount !== 0) report({ backgroundTasks: 0 })
      stop()
      return
    }
    // 引擎会接着做：续跑的回合紧跟在集合变化后面开始，等它一会儿
    settle ??= setTimeout(() => {
      if (lastCount !== 0) report({ backgroundTasks: 0 })
      stop()
    }, host.settleMs)
    settle.unref?.()
  }

  const off = link.onNotification((method, params) => {
    if (!isObject(params) || params.threadId !== threadId) return
    const turn = isObject(params.turn) ? params.turn : null
    if (method === 'turn/started' && typeof turn?.id === 'string') turns.set(turn.id, null)
    else if (method === 'item/completed' && typeof params.turnId === 'string') {
      const item = isObject(params.item) ? params.item : null
      if (item?.type === 'agentMessage' && typeof item.text === 'string')
        turns.set(params.turnId, item.text)
    } else if (method === 'turn/completed' && typeof turn?.id === 'string') {
      const text = turns.get(turn.id) ?? null
      turns.delete(turn.id)
      if (turn.litchOrigin === 'backgroundTask') {
        const summary = host.summaryOf(text)
        report({
          ...(summary !== null ? { summary } : {}),
          backgroundTasks: host.backgroundRunning(threadId),
        })
      }
    }
    review()
  })
  const unclose = link.onClose(() => stop())
  const limit = setTimeout(() => {
    host.log(`会话 ${threadId} 的后台任务过了时限还没跑完，不再盯`)
    stop()
  }, host.limitMs)
  limit.unref?.()
  review()
  return stop
}
