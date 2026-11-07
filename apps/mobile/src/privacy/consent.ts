import { ChannelError, type CoreChannel } from '@litch/core'
import type { JsonFile } from '../shell/json-file'

export interface ConsentTarget {
  deviceId: string
  device: string
  harness: string
  provider: string
  label: string
  model: string | null
  // 不保存令牌或凭据，只存服务配置的非敏感版本指纹。
  revision: string
  remember: boolean
  incomplete?: boolean
  delegated: boolean
}

export type ConsentRecords = Record<string, string>
export const consentKey = (target: ConsentTarget): string =>
  JSON.stringify([target.deviceId, target.harness, target.provider])
const fingerprint = (targets: ConsentTarget[]): string =>
  JSON.stringify(targets.map((t) => [consentKey(t), t.revision, t.remember, t.model, t.label]))

// 在手机唯一命令出口守住所有可能传出内容/继续模型处理的操作。
// 阅读、停止、拒绝/移除设备等不需要授予新的数据许可。
export function needsAIConsent(name: string, params?: unknown): boolean {
  if (name === 'tasks.pause') return (params as { paused?: boolean })?.paused === false
  if (name === 'session.configure')
    return (params as { settings?: { model?: string } })?.settings?.model !== undefined
  return new Set([
    'session.create',
    'session.send',
    'session.edit',
    'session.steer',
    'session.resumeQueue',
    'session.compact',
    'session.implementPlan',
    'session.goal.set',
    'session.recover',
    'session.respond',
    'session.spawn',
    'session.proposal.accept',
    'session.proposal.answer',
    'session.proposal.here',
    'session.queuedNotes.deliver',
    'session.sideChat',
    'files.uploadAttachment',
    'managers.create',
    'managers.update',
    'managers.reset',
    'managers.answers.submit',
    'managers.feedback.submit',
    'managers.question.ask',
    'managers.question.forward',
    'managers.post.question',
    'managers.post.forward',
    'tasks.create',
    'tasks.update',
    'tasks.runNow',
  ]).has(name)
}

export interface ConsentRequest {
  targets: ConsentTarget[]
  answer(allow: boolean): void
}

export function consentChannel(
  base: CoreChannel,
  records: JsonFile<ConsentRecords>,
  resolve: (name: string, params: unknown) => Promise<ConsentTarget[]>,
  show: (request: ConsentRequest | null) => void,
  cancelled: () => string,
  platform: string,
): { channel: CoreChannel; dispose(): void } {
  // AI 数据同意属于 iOS 的发送前告知。Android 不解析目标、不排队，也不触发收键盘浮层。
  if (platform !== 'ios') return { channel: base, dispose() {} }
  let stopped = false
  let decline: (() => void) | null = null
  let queue = Promise.resolve()
  const cancelError = () => new ChannelError('cancelled', cancelled())
  const channel: CoreChannel = {
    ...base,
    async command(name, params, options) {
      if (!needsAIConsent(name, params)) return base.command(name, params, options)
      // 在同一浮层中顺序询问；取消只取消本次操作，不吞掉另一次明确请求。
      let release!: () => void
      const previous = queue
      queue = new Promise<void>((done) => {
        release = done
      })
      await previous
      try {
        for (;;) {
          if (stopped || options?.signal?.aborted) throw cancelError()
          const targets = await resolve(name, params)
          if (stopped || options?.signal?.aborted) throw cancelError()
          const saved = records.read() ?? {}
          const missing = targets.filter((t) => !t.remember || saved[consentKey(t)] !== t.revision)
          if (!missing.length) break
          const allow = await new Promise<boolean>((done) => {
            let answered = false
            const answer = (value: boolean) => {
              if (answered) return
              answered = true
              decline = null
              // 协议允许最小 AbortSignalLike；真实原生 signal 支持释放监听。
              ;(options?.signal as AbortSignal | undefined)?.removeEventListener?.('abort', abort)
              show(null)
              done(value)
            }
            const abort = () => answer(false)
            decline = abort
            options?.signal?.addEventListener('abort', abort, { once: true })
            show({ targets: missing, answer })
            if (stopped || options?.signal?.aborted) abort()
          })
          if (!allow || stopped || options?.signal?.aborted) throw cancelError()
          // 浮层展示期间远端或另一客户端可能换了服务，不能把旧同意套到新目标。
          const current = await resolve(name, params)
          if (stopped || options?.signal?.aborted) throw cancelError()
          if (fingerprint(current) !== fingerprint(targets)) continue
          const next = records.read() ?? {}
          for (const target of missing)
            if (target.remember) next[consentKey(target)] = target.revision
          records.write(next)
          break
        }
        if (stopped || options?.signal?.aborted) throw cancelError()
        return await base.command(name, params, options)
      } finally {
        release()
      }
    },
  }
  return {
    channel,
    dispose() {
      stopped = true
      decline?.()
    },
  }
}
