// 桌面和手机共用：勾选工作树就预检实际启动目录，未查完或不能创建时禁止开始；取消勾选即可共享目录。
import type { CoreChannel } from '@litch/core'
import { useEffect, useMemo, useState } from 'react'

export function useProposalWorktree(
  channel: CoreChannel,
  deviceId: string,
  sessionId: string,
  proposalId: string | undefined,
  enabled: boolean,
  cwd?: string,
): 'worktree.check.pending' | 'worktree.check.failed' | 'worktree.check.notRepo' | null {
  // 每次重新勾选也生成新身份，不能在 effect 执行前短暂复用上一次检查结果。
  const key = useMemo(
    () => ({ deviceId, sessionId, proposalId, cwd, enabled }),
    [deviceId, sessionId, proposalId, cwd, enabled],
  )
  const [result, setResult] = useState<{ key: object | null; available?: boolean }>({ key: null })
  useEffect(() => {
    if (!enabled || !proposalId) return
    let current = true
    setResult({ key: null })
    void channel
      .command('session.proposal.checkWorktree', {
        deviceId,
        sessionId,
        proposalId,
        ...(cwd === undefined ? {} : { cwd }),
      })
      .then(
        ({ available }) => {
          if (current) setResult({ key, available })
        },
        () => {
          if (current) setResult({ key })
        },
      )
    return () => {
      current = false
    }
  }, [channel, deviceId, sessionId, proposalId, enabled, cwd, key])
  if (!enabled || !proposalId) return null
  if (result.key !== key) return 'worktree.check.pending'
  if (result.available === undefined) return 'worktree.check.failed'
  return result.available ? null : 'worktree.check.notRepo'
}
