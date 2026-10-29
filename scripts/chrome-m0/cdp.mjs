// M0 隔离 Chrome 的验收通道，不是产品的浏览器控制接口。
export class Cdp {
  next = 0
  pending = new Map()
  listeners = new Set()
  static async connect(url) {
    const self = new Cdp()
    self.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      self.ws.addEventListener('open', resolve, { once: true })
      self.ws.addEventListener('error', reject, { once: true })
    })
    self.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const pending = self.pending.get(message.id)
      if (pending) {
        self.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve(message.result)
      } else for (const listener of self.listeners) listener(message)
    })
    return self
  }
  call(method, params = {}, sessionId) {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('CDP 关闭'))
    }
    this.pending.clear()
    this.ws.close()
  }
}

export async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label} 超时${last ? `：${last.message}` : ''}`)
}
