// 开着会话就算读过了（桌面 App.tsx 选中的会话、手机详情页共用）：摘要上的未读一出现就清掉，
// 打开之前就有的、摘要比打开晚到的都算。开着的时候核心自己不会再标（会话有人订阅着），
// 离开以后回合再结束才重新标。不依赖 React，手机直接引用
import type { CoreChannel, KeyedStore, SessionChildren, SessionSummary } from '@litch/core'
import { keys } from '@litch/core'

/** 从完整目录选取未读，不受侧栏折叠、分页、项目或经理筛选影响。 */
export function unreadInScope(
  unread: readonly string[],
  children: SessionChildren,
  root?: string,
): string[] {
  if (root === undefined) return [...new Set(unread)]
  const included = new Set<string>()
  const pending = [root]
  while (pending.length) {
    const id = pending.pop()
    if (id === undefined || included.has(id)) continue
    included.add(id)
    pending.push(...(children[id] ?? []))
  }
  return [...new Set(unread)].filter((id) => included.has(id))
}

/** 批量入口仍走原有命令，让摘要、角标和持久快照一致；不打开会话、不新增已读机制。 */
export async function markReadScope(
  channel: CoreChannel,
  store: KeyedStore,
  deviceId: string,
  root?: string,
): Promise<void> {
  const targets = unreadInScope(
    store.get<string[]>(keys.catalogUnread(deviceId)) ?? [],
    store.get<SessionChildren>(keys.children(deviceId)) ?? {},
    root,
  )
  for (const sessionId of targets)
    await channel.command('session.markRead', { deviceId, sessionId })
}

export function readWhileOpen(
  channel: CoreChannel,
  store: KeyedStore,
  deviceId: string,
  sessionId: string,
): () => void {
  const key = keys.summary(deviceId, sessionId)
  // 命令发出去、摘要还没改过来时别的字段变了也会叫一次：同一段未读只发一次
  let asked = false
  const check = () => {
    if (store.get<SessionSummary>(key)?.unread !== true) {
      asked = false
      return
    }
    if (asked) return
    asked = true
    channel.command('session.markRead', { deviceId, sessionId }).catch(() => {
      asked = false
    })
  }
  check()
  return store.subscribe(key, check)
}
