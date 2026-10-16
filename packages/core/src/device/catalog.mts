// 会话目录怎么取：翻页取完、按标识去重、记下这一次没有包含进来的 harness。
// 单 harness 模式和完整模式走的是同一条路：前者不会重复，也没有“没包含进来的 harness”。
import type {
  ClientRequests,
  Thread,
  ThreadListSkippedHarness,
} from '../../../protocol/src/index.mjs'
import type { HarnessId } from '../model.mjs'

type ListResult = ClientRequests['thread/list']['result']

/** 翻页的上限。对面的游标出问题时不至于一直翻下去 */
const MAX_PAGES = 500

export interface Listing {
  threads: Thread[]
  /** 这一次没有包含进来的 harness（当时不可用，或者问了没成）。只有聚合面会给 */
  skipped: ThreadListSkippedHarness[]
}

/**
 * 把一份列表翻页取完。
 * 聚合面的列表是几个 harness 合并的，翻页期间列表有变动时同一个会话可能给两次：按标识去重，留更新时间晚的那份。
 */
export async function collectThreads(
  fetch: (cursor: string | null) => Promise<ListResult>,
): Promise<Listing> {
  const byId = new Map<string, Thread>()
  const skipped = new Map<string, ThreadListSkippedHarness>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetch(cursor)
    for (const thread of result.data) {
      const seen = byId.get(thread.id)
      if (!seen || thread.updatedAt >= seen.updatedAt) byId.set(thread.id, thread)
    }
    // 同一个 harness 在几页里都可能被报出来：问了没成的比“当时不可用”说得更具体，留它
    for (const entry of result.skippedHarnesses ?? []) {
      if (skipped.get(entry.harness)?.reason !== 'failed') skipped.set(entry.harness, entry)
    }
    if (!result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  return { threads: [...byId.values()], skipped: [...skipped.values()] }
}

/**
 * 新取到的列表并进原来的目录：列表里有的以列表为准；这一次没有包含进来的 harness，
 * 它原来的那些会话留着（是上次的内容）。当时在跑也好、在等也好，现在都不知道了，一律当成没载入。
 * only 给了就是只取了这一个 harness 的：别的 harness 的会话原样不动。
 * down 是设备服务现在声明为不可用的 harness：列表里一个它的会话都没有的话，也按“没有包含进来”算。
 * 不能只听列表自己报的那份名单——停用了的、没装的 harness 设备进程根本没去连，名单里没有它
 * （实测 2026-10-13），只听名单的话，停用一个 harness 再对一次账，它的会话就从侧栏里没了。
 * 列表里有它的会话，说明对面这次问到它了（它已经恢复，只是状态变化的通知还没到）：以列表为准。
 */
export function mergeListing(
  previous: Iterable<Thread>,
  listing: Listing,
  harnessOf: (thread: Thread) => HarnessId,
  only: HarnessId | null = null,
  down: Iterable<HarnessId> = [],
): Map<string, Thread> {
  const listed = new Set(listing.threads.map(harnessOf))
  const missing = new Set(listing.skipped.map((entry) => entry.harness))
  for (const harness of down) if (!listed.has(harness)) missing.add(harness)
  const next = new Map<string, Thread>()
  for (const thread of previous) {
    const harness = harnessOf(thread)
    if (only !== null && harness !== only) next.set(thread.id, thread)
    else if (missing.has(harness)) {
      next.set(thread.id, { ...thread, turns: [], status: { type: 'notLoaded' } })
    }
  }
  // 目录里不留回合，会话内容打开时再取
  for (const thread of listing.threads) next.set(thread.id, { ...thread, turns: [] })
  return next
}
