// 只安装在隔离搜索验收页面，保留有界的 Worker 收发与异常轨迹；不改变请求或结果。
export function installSearchTrace() {
  const events = []
  let sequence = 0
  const record = (event) => {
    events.push({ at: performance.now(), ...event })
    if (events.length > 200) events.shift()
  }
  window.__litchSearchTrace = { origin: performance.timeOrigin, events }
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args)
      this.traceId = ++sequence
      record({ worker: this.traceId, kind: 'create', url: String(args[0]) })
      this.addEventListener('message', ({ data }) =>
        record({
          worker: this.traceId,
          kind: 'result',
          query: data?.query,
          revision: data?.revision,
          count: data?.count,
        }),
      )
      this.addEventListener('error', (event) =>
        record({ worker: this.traceId, kind: 'error', message: event.message }),
      )
      this.addEventListener('messageerror', () =>
        record({ worker: this.traceId, kind: 'messageerror' }),
      )
    }
    postMessage(message, ...rest) {
      record({
        worker: this.traceId,
        kind: 'send',
        type: message?.type,
        query: message?.query,
        revision: message?.revision,
        sources: message?.sources?.length,
      })
      return super.postMessage(message, ...rest)
    }
    terminate() {
      record({ worker: this.traceId, kind: 'terminate' })
      return super.terminate()
    }
  }
  window.addEventListener('unhandledrejection', (event) =>
    record({ kind: 'unhandledrejection', message: String(event.reason?.stack ?? event.reason) }),
  )
  window.addEventListener('error', (event) => record({ kind: 'pageError', message: event.message }))
}
