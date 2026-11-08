// 内置浏览器的审批卡（ClientToolAsk）转成通用合同的审批主题，供把 context.ask 接到 ApprovalPort 的宿主使用。
import type { ApprovalSubject } from '../../automation-contracts/src/runtime.mjs'
import type { ClientToolAsk } from './tool-port.mjs'

export function browserApprovalSubject(ask: ClientToolAsk): ApprovalSubject {
  switch (ask.kind) {
    case 'browserDownload':
      return {
        kind: 'download',
        filename: ask.filename,
        origin: ask.origin,
        totalBytes: ask.totalBytes,
      }
    case 'site':
      return { kind: 'site', origin: ask.origin, url: ask.url, browser: ask.browser ?? 'builtin' }
    case 'signIn':
      return { kind: 'action', description: `Sign in at ${ask.origin}: ${ask.reason}` }
    default:
      return { kind: 'action', description: 'Approve browser operation' }
  }
}
