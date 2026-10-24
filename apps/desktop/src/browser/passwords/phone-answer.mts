// 手机经会话所在设备答的登录卡片（22 号文档第八节）：设备服务不可信，答复要验过手机批准钥匙的签名才认。
// 真的验签在 apps/desktop/src/approvals/verify.mts（照这里的 VerifyPhoneAnswer 写）；这里只有约定和一个
// 一律不认的桩：没接上验签之前，手机的答复全部丢掉，卡片接着等桌面端答。
import type { SignInRequest } from './signin.mjs'

/** 交给验签的卡片：桌面端自己发出去的那张（编号、随机数、源、账号的 ref、过期时间、是不是定时任务的回合） */
export type PhoneAnswerCard = Pick<
  SignInRequest,
  'id' | 'nonce' | 'origin' | 'accounts' | 'taskId' | 'expiresAt'
>

/**
 * 验签的结论。choice 是选的账号（卡片里的 ref），拒绝是 null；remember 是“以后直接用这个账号”（签进去的）；
 * firstSeen：这把批准钥匙是这次第一次批准时记下的（桌面端要出提示）
 */
export type PhoneAnswerVerdict =
  | { ok: true; phoneId: string; choice: string | null; remember: boolean; firstSeen: boolean }
  | { ok: false; why: string }

export type VerifyPhoneAnswer = (
  card: PhoneAnswerCard,
  answer: unknown,
) => PhoneAnswerVerdict | Promise<PhoneAnswerVerdict>

/** 答复里说它答的是哪张卡片；认不出是 null（不等于认了，认不认看验签） */
export function phoneAnswerCardId(answer: unknown): string | null {
  const id = (answer as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

/** 还没接上验签时用的桩：一律不认 */
export const rejectPhoneAnswers: VerifyPhoneAnswer = () => ({
  ok: false,
  why: 'phone approvals are not verified yet',
})
