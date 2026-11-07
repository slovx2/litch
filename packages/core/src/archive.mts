import type { ArchiveBlockingSession } from '../../protocol/src/device.mjs'
import { ChannelError } from './channel/protocol.mjs'
import type { SessionSummary } from './model.mjs'
import { phrase } from './phrase.mjs'

/** 两端共用错误，现有提示组件按语言渲染完整的子会话名单。 */
export function archiveChildrenFailure(sessions: readonly ArchiveBlockingSession[]): ChannelError {
  const names = sessions.map((one) => `${one.title} (${one.threadId})`).join(', ')
  return new ChannelError(
    'busy',
    `Stop sub-sessions before archiving: ${names}`,
    phrase('session.archiveChildrenRunning', { sessions: names }),
  )
}

/** 客户端先拦已知活跃后代；设备仍负责核对未加载或其他客户端刚启动的子树。 */
export function assertArchiveChildrenStopped(
  parentId: string,
  summaries: readonly SessionSummary[],
): void {
  const children = new Map<string, SessionSummary[]>()
  for (const summary of summaries) {
    const parent = summary.lineage?.parentId
    if (parent) children.set(parent, [...(children.get(parent) ?? []), summary])
  }
  const seen = new Set([parentId])
  const queue = [parentId]
  const running: ArchiveBlockingSession[] = []
  for (const current of queue) {
    for (const child of children.get(current) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      queue.push(child.id)
      if (
        child.status === 'running' ||
        child.status === 'waiting' ||
        (child.background?.running ?? 0) > 0
      )
        running.push({
          threadId: child.id,
          title: typeof child.title === 'string' ? child.title : child.id,
        })
    }
  }
  if (running.length) throw archiveChildrenFailure(running)
}
