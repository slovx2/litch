// 打开即读：列表里展开的特殊 issue 和全屏阅读页共用。有新回复的标已读；报告的未读由“已阅”管，不在这里清。
import { useEffect, useRef } from 'react'
import type { ManagerView } from '../../../../core/src/model-manager.mts'
import type { ManagerIssue } from '../../../../protocol/src/manager-issues.mts'
import type { IssueCommands } from './data.ts'

export function useIssueSeen({
  manager,
  issue,
  open,
  disabled,
  commands,
}: {
  manager: ManagerView
  issue: ManagerIssue | undefined
  open: boolean
  disabled: boolean
  commands: IssueCommands
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
