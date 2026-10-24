// 开着会话就算读过了（桌面 App.tsx 选中的会话、手机详情页共用）：摘要上的未读一出现就清掉，
// 打开之前就有的、摘要比打开晚到的都算。开着的时候核心自己不会再标（会话有人订阅着），
// 离开以后回合再结束才重新标。不依赖 React，手机直接引用
import type { CoreChannel, KeyedStore, SessionSummary } from '@litch/core'
import { keys } from '@litch/core'

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
