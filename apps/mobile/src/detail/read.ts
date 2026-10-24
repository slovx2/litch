// 开着会话就算读过了（照桌面 packages/ui/src/app/App.tsx 选中会话时）：摘要上的未读一出现就清掉，
// 进来之前就有的、摘要比页面晚到的都算。开着的时候核心自己不会再标（会话有人订阅着），
// 离开以后回合再结束才重新标；离开后会话存储还留着订阅的那一阵见 src/core/store-cache.ts
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
