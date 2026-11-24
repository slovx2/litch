// 打开即读：半屏抽屉和完整讨论页共用。有新回复的标已读；报告的未读由“已阅”管，不在这里清。
import type { ManagerView } from '@litch/core'
import { useEffect, useRef } from 'react'
import type { ManagerIssue } from '../../../../../../packages/protocol/src/manager-issues.mts'
import type { IssueCommands } from './data'

export function useIssueSeen({
  manager,
  issue,
  open,
  disabled,
  commands,
}: {
  manager: Pick<ManagerView, 'deviceId' | 'id'>
  issue: ManagerIssue | undefined
  open: boolean
  disabled: boolean
  commands: Pick<IssueCommands, 'seen'>
}) {
  const seenAttempt = useRef('')
  useEffect(() => {
    if (!open || !issue?.unread || issue.kind === 'report' || disabled) {
      seenAttempt.current = ''
      return
    }
    // 同一份未读快照只确认一次：慢响应、超时期间重复推来的快照不重发
    const key = JSON.stringify([
      manager.deviceId,
      manager.id,
      issue.id,
      issue.revision,
      issue.updatedAt,
      issue.discussion.comments.at(-1)?.id,
      issue.discussion.comments.at(-1)?.revision,
    ])
    if (seenAttempt.current === key) return
    seenAttempt.current = key
    void commands.seen({ id: issue.id, revision: issue.revision }).catch(() => {})
  }, [open, issue, commands, disabled, manager.deviceId, manager.id])
}
