// dsh-poc-serve.mjs 经 DSH_HOME/cordis.patch.yml 插进 dsh 的诊断插件，只在打样实例里用。
// dsh 以 web 方式跑时自己的日志只进它进程里的缓冲，出了事外面一行也看不到：这里把 warn、error 写到标准错误
// （适配器转进运行日志），另把标题请求的去向（发起、头一块、怎么结束、抛错、被取消）各写一行，
// 标题没落到线程上时分得清是请求没发出去、出了错，还是被 dsh 自己作废了。
import { format } from 'node:util'

export const name = 'cha-dsh-poc-diagnostics'

/** 运行日志里这几行的标记，dsh-poc-serve.mjs 按它挑出来 */
export const MARK = '[dsh-poc-diag]'

const say = (...args) => process.stderr.write(`${MARK} ${Date.now()} ${format(...args)}\n`)

export function apply(ctx) {
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
