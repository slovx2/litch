// 同一个线程里的一对端口。用在两处：测试；界面在普通浏览器里对着模拟核心运行时。
// 消息异步送达，发出时深拷贝一份，和真的消息端口一样：一头事后再改自己手里的对象，
// 不会影响另一头已经收到的。拷贝用 JSON 往返，所以只能传纯数据。
import type { Port } from './protocol.mjs'

interface End {
  handler: ((message: unknown) => void) | null
  backlog: unknown[]
  closed: boolean
}

function deliver(to: End, message: unknown): void {
  if (to.closed) return
  if (!to.handler) {
    // 对面还没开始听，先存着
    to.backlog.push(message)
    return
  }
  const handler = to.handler
  Promise.resolve().then(() => {
    if (!to.closed) handler(message)
  })
}

function makePort(self: End, peer: End): Port {
  return {
    post(message) {
      if (!self.closed) deliver(peer, JSON.parse(JSON.stringify(message)))
    },
    listen(handler) {
      self.handler = handler
      for (const message of self.backlog.splice(0)) deliver(self, message)
    },
    close() {
      self.closed = true
      self.backlog.length = 0
    },
  }
}

export function createPortPair(): [Port, Port] {
  const a: End = { handler: null, backlog: [], closed: false }
  const b: End = { handler: null, backlog: [], closed: false }
  return [makePort(a, b), makePort(b, a)]
}
