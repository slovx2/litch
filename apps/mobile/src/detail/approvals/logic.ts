// 手机只签自身访问批准；旧版代理代填卡片不生成签名。
import {
  type ApprovalAnswer,
  type ApprovalCard,
  approvalSignedText,
} from '../../../../../packages/protocol/src/client-approvals.mts'

/** 人在卡片上选的：ref 是账号（拒绝是 null）；remember 只有定时任务的卡片才算数 */
export interface ApprovalChoice {
  ref: string | null
  remember: boolean
}

/** 签名的一方：这台设备上的手机号、手机名、批准公钥，加上签名（已经过了系统验证） */
export interface Signer {
  phoneId: string
  phoneName: string
  approvalKey: string
  sign(text: string): Promise<string>
}

/**
 * 拼答复并签名。签的是手机看到的这张卡片（id、nonce、desktopId 和摘要里的 origin 原样取卡片上的），
 * 设备改过卡片内容的话，桌面端拿自己记着的对不上就不认
 */
export async function buildAnswer(
  card: ApprovalCard,
  choice: ApprovalChoice,
  signer: Signer,
): Promise<ApprovalAnswer> {
  if (card.kind === 'browserSite') throw new Error('请在执行操作的 Litch 桌面会话中处理网站审批')
  const decision = choice.ref === null ? 'decline' : 'approve'
  if (card.kind === 'browserSignIn') throw new Error('代理代填已移除，请用户在电脑上手动登录')
  if (decision === 'approve' && !['once', 'session', 'always'].includes(choice.ref ?? ''))
    throw new Error('卡片上没有这个授权范围')
  const signed = {
    ref: choice.ref,
    decision,
    remember: false,
    phoneId: signer.phoneId,
  } as const
  return {
    id: card.id,
    ...signed,
    phoneName: signer.phoneName,
    approvalKey: signer.approvalKey,
    signature: await signer.sign(
      approvalSignedText(
        { id: card.id, nonce: card.nonce, desktopId: card.desktopId, origin: card.summary.origin },
        signed,
      ),
    ),
  }
}
