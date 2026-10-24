// 手机批准钥匙的提示（不挡事）：第一次记下一部手机的批准钥匙、某部手机带来的钥匙对不上时，出一条留到关掉的提示。
// 只有桌面外壳有（approvals-bridge.ts）；挂在 App 里，不画任何东西。
import { useEffect } from 'react'
import { showToast } from '../app/toasts.tsx'
import { approvalsBridge } from './approvals-bridge.ts'

export function ApprovalNotices() {
  useEffect(
    () =>
      approvalsBridge()?.onNotice((notice) => {
        if (notice.kind === 'firstSeen') {
          showToast({
            id: `approval-first:${notice.phoneId}`,
            text: (t) =>
              t('approvals.firstSeen', { name: notice.name, fingerprint: notice.fingerprint }),
            lifeMs: 0,
          })
        } else {
          showToast({
            id: `approval-mismatch:${notice.phoneId}`,
            text: (t) => t('approvals.mismatch', { name: notice.name }),
            tone: 'err',
            lifeMs: 0,
          })
        }
      }),
    [],
  )
  return null
}
