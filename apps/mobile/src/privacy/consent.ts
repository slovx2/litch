import { ChannelError, type CoreChannel } from '@litch/core'
import type { ConsentAccess } from './consent-access'

export type ConsentRecords = Record<string, string>

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

export function consentChannel(
  base: CoreChannel,
  access: ConsentAccess,
  required: () => string,
  platform: string,
): CoreChannel {
  // Android 完全沿用原通道，不请求许可、不收键盘、不引入发送队列。
  if (platform !== 'ios') return base
  return {
    ...base,
    async command(name, params, options) {
      if (needsAIConsent(name, params) && !access.allowed()) {
        access.require()
        // 发送与告知不再共享 Promise。拒绝许可、返回或浮层卸载均不能取消发送。
        // 本次命令尚未执行，界面保留草稿；明确同意后由用户再次发送。
        throw new ChannelError('rejected', required())
      }
      return base.command(name, params, options)
    },
  }
}
