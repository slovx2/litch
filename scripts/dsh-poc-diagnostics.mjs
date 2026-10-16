// dsh-poc-serve.mjs 经 DSH_HOME/cordis.patch.yml 插进 dsh 的诊断插件，只在打样实例里用。
// dsh 以 web 方式跑时自己的日志只进它进程里的缓冲，出了事外面一行也看不到：这里把 warn、error 写到标准错误
// （适配器转进运行日志），另把标题请求的去向（发起、头一块、怎么结束、抛错、被取消）各写一行，
// 标题没落到线程上时分得清是请求没发出去、出了错，还是被 dsh 自己作废了。
// 模型请求的 fetch 也各记一行（发起、应答、失败带 cause 链）：dsh 报给外面的失败只有一句话和一个码。
import { format } from 'node:util'

export const name = 'cha-dsh-poc-diagnostics'

/** 运行日志里这几行的标记，dsh-poc-serve.mjs 按它挑出来 */
export const MARK = '[dsh-poc-diag]'

const say = (...args) => process.stderr.write(`${MARK} ${Date.now()} ${format(...args)}\n`)

// 一个错误连同它的 cause 链压成一行：dsh 把模型请求的失败归成一句话和一个码，原因丢掉了
function causes(error) {
  const parts = []
  for (let at = error, depth = 0; at !== undefined && at !== null && depth < 6; depth++) {
    if (typeof at !== 'object') {
      parts.push(String(at))
      break
    }
    const facts = ['code', 'errno', 'syscall', 'address', 'port']
      .filter((key) => at[key] !== undefined)
      .map((key) => `${key}=${at[key]}`)
    parts.push(`${at.name}: ${at.message}${facts.length ? ` (${facts.join(' ')})` : ''}`)
    if (at.cause === undefined) {
      const frames = String(at.stack ?? '')
        .split('\n')
        .filter((line) => line.trimStart().startsWith('at '))
      parts.push(
        frames
          .slice(0, 4)
          .map((line) => line.trim())
          .join(' < '),
      )
    }
    at = at.cause
  }
  return parts.join(' <- ')
}

// Node 自带的 fetch 用的全局 dispatcher：每个对象编个号，看请求时用的是哪一个、是不是已经关了
const dispatchers = new WeakMap()
let numbered = 0
function dispatcher() {
  const current = globalThis[Symbol.for('undici.globalDispatcher.1')]
  if (current === undefined) return 'dispatcher 未建'
  if (!dispatchers.has(current)) dispatchers.set(current, ++numbered)
  const flags = ['closed', 'destroyed'].filter((key) => current[key] === true)
  return `dispatcher#${dispatchers.get(current)} ${current.constructor?.name}${flags.length ? ` ${flags.join(' ')}` : ''}`
}

// 模型请求（…/messages）的 fetch 包一层：发起、应答、失败各一行，失败带整条 cause 链。
// 插件被热重载时旧的一份只是停手；全局 fetch 还是自己装的那个才放回原来的
function watchFetch(ctx) {
  ctx.effect(() => {
    const original = globalThis.fetch
    let active = true
    const wrapped = function (input, init) {
      const url = String(input?.url ?? input)
      if (!active || !url.endsWith('/messages')) return original.call(this, input, init)
      let id = '-'
      try {
        id = new Headers(init?.headers).get('x-deepseek-harness-session-id') ?? '-'
      } catch (error) {
        say('fetch headers unreadable', causes(error))
      }
      const kind =
        typeof init?.body !== 'string'
          ? `正文是 ${typeof init?.body}`
          : init.body.includes('"tools":')
            ? '带工具'
            : '不带工具'
      say('fetch', id, kind, dispatcher())
      return original.call(this, input, init).then(
        (response) => {
          say('fetch answered', id, kind, response.status)
          return response
        },
        (error) => {
          say('fetch failed', id, kind, dispatcher(), causes(error))
          throw error
        },
      )
    }
    globalThis.fetch = wrapped
    return () => {
      active = false
      if (globalThis.fetch === wrapped) globalThis.fetch = original
    }
  })
}

// fetch 之前也可能出错（凭据、附件、请求扩展……），dsh 一样归成 TRANSPORT。模型服务适配器里发请求的那个方法
// （dsh 0.2.0-rc.2 的 DeepSeekAdapter.request）在实例上包一层，里面抛出的都带 cause 链记一行；形状不对就不包
const watchedAdapters = new WeakSet()
function watchAdapter(ctx, provider) {
  const adapter = ctx.get('llm')?.adapters?.get?.(provider)?.adapter
  if (!adapter || watchedAdapters.has(adapter) || typeof adapter.request !== 'function') return
  watchedAdapters.add(adapter)
  say('adapter watched', provider)
  const request = adapter.request
  adapter.request = async function* (options, ...rest) {
    try {
      yield* request.call(this, options, ...rest)
    } catch (error) {
      say(
        'adapter request threw',
        options?.sessionId ?? '-',
        options?.purpose ?? '-',
        causes(error),
      )
      throw error
    }
  }
}

export function apply(ctx) {
  watchFetch(ctx)
  // 级别：error 0、info 1、warn 2
  ctx.logger.exporter({
    levels: { default: 2 },
    export: ({ name, type, args }) => {
      if (type === 'warn' || type === 'error') say(`${type} ${name}:`, ...args)
    },
  })
  ctx.on(
    'llm/stream',
    (options, next) => {
      try {
        watchAdapter(ctx, options.provider)
      } catch (error) {
        say('adapter not watched', causes(error))
      }
      if (options.purpose !== 'session-title') return next()
      const id = options.sessionId
      say('title requested', id)
      options.signal?.addEventListener('abort', () =>
        say('title aborted', id, String(options.signal.reason?.message ?? options.signal.reason)),
      )
      return (async function* () {
        let count = 0
        let settled = false
        try {
          for await (const chunk of next()) {
            if (count++ === 0) say('title first chunk', id, chunk.type)
            if (chunk.type === 'finish') say('title finish', id, JSON.stringify(chunk.reason))
            yield chunk
          }
          settled = true
          say('title ended', id, count)
        } catch (error) {
          settled = true
          say('title threw', id, error)
          throw error
        } finally {
          if (!settled) say('title closed early', id, count)
        }
      })()
    },
    { global: true, prepend: true },
  )
  ctx.on('session/disposed', (session) => say('session disposed', session.id))
}
