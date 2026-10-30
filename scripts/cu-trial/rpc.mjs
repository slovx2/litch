// Codex app-server 标准输入输出驱动；原始事件由调用方保存，不经 Litch 会话树。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function startCodex(executable, env, cwd, record, onRequest) {
  const child = spawn(executable, ['app-server'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map(),
    waiters = new Set(),
    events = []
  let next = 0
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    record(message)
    if (message.method && message.id !== undefined) {
      Promise.resolve(onRequest(message)).then(
        (result) => send({ jsonrpc: '2.0', id: message.id, result }),
        (error) =>
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }),
      )
    } else if (message.id !== undefined) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)))
      else request?.resolve(message.result)
    } else {
      events.push(message)
      for (const waiter of waiters) if (waiter.accept(message)) waiter.finish(message)
    }
  })
  child.stderr.on('data', (data) => record({ stderr: String(data) }))
  const fail = (error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    for (const waiter of waiters) waiter.fail(error)
  }
  child.on('error', fail)
  child.on('exit', (code) => fail(new Error(`Codex exited: ${code}`)))
  return {
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise((done) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          done()
        })
        child.kill('SIGTERM')
      })
    },
    call(method, params) {
      const id = ++next
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} 超时`))
        }, 30_000)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        send({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify: (method, params = {}) => send({ jsonrpc: '2.0', method, params }),
    wait(accept, ms = 300_000) {
      const seen = events.find(accept)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const remove = () => {
          clearTimeout(timer)
          waiters.delete(waiter)
        }
        const waiter = {
          accept,
          finish: (value) => {
            remove()
            resolve(value)
          },
          fail: (error) => {
            remove()
            reject(error)
          },
        }
        const timer = setTimeout(() => waiter.fail(new Error('回合超时')), ms)
        waiters.add(waiter)
      })
    },
  }
}
