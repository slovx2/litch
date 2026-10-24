// 手机批准测试用的一张卡片和一个答复（形状合扩展定义，签名是假的：设备进程不验签）
import type { ApprovalAnswer, ApprovalCard } from '../../protocol/src/client-approvals.mjs'

export const card = (more: Partial<ApprovalCard> = {}): ApprovalCard => ({
  id: 'Ap7cK2mQ9xW4rT6v',
  threadId: 'thread-1',
  kind: 'browserSignIn',
  summary: {
    origin: 'https://github.com',
    site: 'GitHub',
    reason: 'Push the branch',
    device: 'song-debian',
    accounts: [
      { ref: 'a1', masked: 'so•••@gmail.com' },
      { ref: 'a2', masked: 'wo•••@corp.com' },
    ],
    task: null,
    fillBlocked: null,
  },
  desktopId: 'Dz5yX2wV8uT1sR4q',
  nonce: 'Nq3vL8sD1fG5hJ0k',
  expiresAt: null,
  ...more,
})

export const answer = (more: Partial<ApprovalAnswer> = {}): ApprovalAnswer => ({
  id: 'Ap7cK2mQ9xW4rT6v',
  ref: 'a1',
  decision: 'approve',
  remember: false,
  phoneId: 'f83898df0bef57a4',
  approvalKey: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  signature: `${'A'.repeat(86)}==`,
  ...more,
})
