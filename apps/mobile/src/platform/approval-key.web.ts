// 网页预览里的批准钥匙（正式的在 approval-key.ts）：没有安全存储和生物识别，钥匙只在内存里，验证直接算过，
// 每台设备的手机号给一个固定的示例值，让登录卡片在模拟核心上能走完“批准 → 送出 → 卡片收掉”。
import { ssh } from '../../modules/litch-ssh/src'
import type { ApprovalKeyInfo, Unlock } from './approval-key'

export type { ApprovalKeyInfo, Unlock }

let info: ApprovalKeyInfo | null = null
let seed = ''

export const approvalKeyInfo = (): ApprovalKeyInfo | null => info

export async function ensureApprovalKey(): Promise<ApprovalKeyInfo> {
  if (info) return info
  const made = await ssh.newApprovalKey()
  seed = made.seed
  info = { approvalKey: made.approvalKey, fingerprint: made.fingerprint, createdAt: Date.now() }
  return info
}

export const unlockForApproval = async (): Promise<Unlock> => ({ ok: true })

export const signWithApprovalKey = (text: string): Promise<string> => ssh.approvalSign(seed, text)

export const phoneIdFor = async (_deviceId: string): Promise<string | null> => 'f83898df0bef57a4'
