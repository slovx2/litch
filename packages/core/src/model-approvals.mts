// 手机上批准在界面这一头的样子（设备的 clientApprovals 扩展投影过来的）。只有手机用：
// 桌面端发的卡片经会话所在的设备转到手机，手机在会话页里画出来，答复由移动端的外壳签好名经 approval.answer 交回去。
// 卡片的形状、签名内容在协议包 client-approvals.mts（approvalSignedText）。
import type {
  ApprovalAccount,
  ApprovalAnswer,
  ApprovalCardView,
  BrowserSignInSummary,
} from '../../protocol/src/client-approvals.mjs'

export type { ApprovalAccount, ApprovalAnswer, ApprovalCardView, BrowserSignInSummary }

export interface ApprovalsTopicView {
  deviceId: string
  /** 设备认这项扩展；没连上时是 null */
  available: boolean | null
  /** 这台设备上现在挂着的全部卡片（各会话的），先开的在前。没连上、还没取到是空的 */
  cards: ApprovalCardView[]
}
