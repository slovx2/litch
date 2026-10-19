// 认出手机端 SSH 模块报的是哪一种失败。Go 那头把种类写在错误文字开头的方括号里（mobile/sshtransport/errors.go），
// 经 gomobile、Expo 一路包过来，前面会多出几层“调用被拒”之类的话，所以在整段字里找。
import { ConnectError, phrase } from '@litch/core'

export type SshKind =
  | 'unreachable'
  | 'hostKeyUnknown'
  | 'hostKeyChanged'
  | 'auth'
  | 'key'
  | 'keyLocked'
  | 'invalid'
  /** 扫码绑定时登进去了，对面却没给出登记结果 */
  | 'enroll'

const KIND =
  /\[(unreachable|hostKeyUnknown|hostKeyChanged|auth|key|keyLocked|invalid|enroll)\] ([^\n]*)/

export interface SshProblem {
  /** 认不出来的是 null，按连不到算 */
  kind: SshKind | null
  /** Go 那头的原话，带着种类的前缀 */
  message: string
}

export function sshProblem(error: unknown): SshProblem {
  const text = error instanceof Error ? error.message : String(error)
  const found = text.match(KIND)
  if (!found) return { kind: null, message: text.trim() }
  return { kind: found[1] as SshKind, message: `[${found[1]}] ${found[2]}` }
}

/**
 * 换成核心认的“在哪一步没成”。给人看的话用桌面端现成的那几句（核心的短语），手机上说法不一样的
 * 由设备页按阶段和详情里的种类换掉（src/screens/devices/failure.ts）；原话放在详情里
 */
export function sshFailure(error: unknown): ConnectError {
  const { kind, message } = sshProblem(error)
  switch (kind) {
    case 'hostKeyUnknown':
      return new ConnectError('hostKey', phrase('ssh.hostKeyUnknown'), false, message)
    case 'hostKeyChanged':
      return new ConnectError('hostKey', phrase('ssh.hostKeyChanged'), false, message)
    case 'auth':
    case 'key':
    case 'keyLocked':
      return new ConnectError('auth', phrase('ssh.auth'), false, message)
    case 'invalid':
      return new ConnectError('unreachable', phrase('ssh.config'), false, message)
    default:
      return new ConnectError('unreachable', phrase('ssh.unreachable'), true, message)
  }
}
