// 聚合面的 thread/list：发给全部可用的上游，合并后返回，顺手把看到的会话记进索引。
// 该问而没问到的上游一个不落地记在应答的 skippedHarnesses 里：正在连的、断了的、
// 适配器主进程说没在跑的（停用了、没装……）、问了没成的。
// 会话的工作区、分区、置顶存在设备层：按它们筛由这里做，列出来的会话对象上这几项也换成设备层的。
import type { ThreadListSkippedHarness } from '../../protocol/src/device.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { type ListSource, mergeThreadList } from './thread-list.mjs'
import type { UpstreamLink } from './upstream.mjs'
import { isObject } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'

export interface ListContext {
  /** 按配置顺序的全部上游，没在跑的（歇着的）也在里面 */
  links: UpstreamLink[]
  /** 按标识取上游；没配置这个 harness 时抛错 */
  link(harness: string): UpstreamLink
  index: ThreadIndex
  workspaces: Workspaces
  timeoutMs: number
  /** 给每一行会话对象挂上设备层另外的字段（声明了 sessionTree 的连接：litchLineage） */
  decorate?(row: Record<string, unknown>): void
}

/**
 * 不交给上游的参数：游标、页大小和排序由聚合面自己定，harness 是聚合面的扩展参数，
 * 工作区、分区、置顶（isPinned 不在协议里，是适配器的引擎多认的）由设备层来筛；
 * excludedThreadIds（0.163.0 起）也由这里筛：别的入口和更早的原生 codex 不认它
 */
const OWN_PARAMS = new Set([
  'cursor',
  'limit',
  'sortKey',
  'sortDirection',
  'harness',
  'projectId',
  'sectionId',
  'isPinned',
  'excludedThreadIds',
])

function source(link: UpstreamLink, timeoutMs: number): ListSource {
  return {
    harness: link.harness,
    async fetch(params) {
      const result = await link.request('thread/list', params, timeoutMs)
      if (!isObject(result) || !Array.isArray(result.data))
        throw new Error('thread/list 的应答形状不对')
      return {
        data: result.data,
        nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null,
      }
    },
  }
}

export async function listThreads(context: ListContext, params: unknown): Promise<unknown> {
  const fields = isObject(params) ? params : {}
  // 三家都有的排序只有这一种
  if (fields.sortKey != null && fields.sortKey !== 'updated_at')
    throw new ProtocolError(
      -32602,
      '聚合面的会话列表只支持按更新时间倒序：sortKey 只能是 updated_at',
    )
  if (fields.sortDirection != null && fields.sortDirection !== 'desc')
    throw new ProtocolError(
      -32602,
      '聚合面的会话列表只支持按更新时间倒序：sortDirection 只能是 desc',
    )
  const limit = fields.limit ?? 50
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ProtocolError(-32602, 'limit 必须在 1 到 1000 之间')
  if (fields.cursor != null && typeof fields.cursor !== 'string')
    throw new ProtocolError(-32602, 'cursor 必须是字符串')
  // 照上游：最多 100 个，不合法就拒绝，不截断
  const excludedIds = fields.excludedThreadIds ?? []
  if (!Array.isArray(excludedIds) || excludedIds.length > 100)
    throw new ProtocolError(-32602, 'excludedThreadIds accepts at most 100 entries')
  if (excludedIds.some((id) => typeof id !== 'string' || !id.trim()))
    throw new ProtocolError(-32602, 'excludedThreadIds 的每一项必须是非空字符串')
  const excluded = new Set(excludedIds as string[])

  let candidates = context.links
  if (typeof fields.harness === 'string' && fields.harness)
    candidates = [context.link(fields.harness)]
  else {
    // 按父会话或祖先会话查的，只有那个会话所在的 harness 答得上
    const parent = fields.parentThreadId ?? fields.ancestorThreadId
    const owner = typeof parent === 'string' ? context.index.lookup(parent) : null
    const only = owner ? context.links.find((link) => link.harness === owner) : undefined
    if (only) candidates = [only]
  }
  const filter = context.workspaces.filter(fields)
  if (filter?.candidates) {
    // 要的是某个工作区、某个分区里的会话，而且它们各属于哪个 harness 都知道：别的 harness 不用问
    const owners = filter.candidates.map((threadId) => context.index.lookup(threadId))
    if (!owners.includes(null))
      candidates = candidates.filter((link) => owners.includes(link.harness))
  }

  const skipped: ThreadListSkippedHarness[] = []
  const sources: ListSource[] = []
  for (const link of candidates) {
    if (link.available) sources.push(source(link, context.timeoutMs))
    else
      skipped.push({
        harness: link.harness,
        reason: 'unavailable',
        // 和 runtime/info 里这个 harness 的 unavailable.kind 出自同一处
        kind: link.failure.kind,
        message: link.failure.message,
      })
  }
  const merged = await mergeThreadList({
    sources,
    limit,
    cursor: typeof fields.cursor === 'string' ? fields.cursor : null,
    filters: Object.fromEntries(Object.entries(fields).filter(([key]) => !OWN_PARAMS.has(key))),
    ...(filter || excluded.size > 0
      ? { accept: (row) => !excluded.has(row.id) && (filter?.accept(row.id) ?? true) }
      : {}),
  })
  context.index.batch(() => {
    // 列表是按归没归档查的，所以这一页的会话归没归档是知道的
    for (const row of merged.data)
      context.index.see(row, String(row.harness), fields.archived === true)
  })
  for (const row of merged.data) {
    context.workspaces.decorate(row.id, row)
    context.decorate?.(row)
  }
  for (const harness of merged.excluded)
    skipped.push({
      harness,
      reason: 'unavailable',
      message: '这一轮翻页开始的时候它不可用，没有包含进来',
    })
  for (const failure of merged.failed)
    skipped.push({ harness: failure.harness, reason: 'failed', message: failure.message })
  return {
    data: merged.data,
    nextCursor: merged.nextCursor,
    backwardsCursor: null,
    skippedHarnesses: skipped,
  }
}
