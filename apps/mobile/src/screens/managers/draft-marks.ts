// 收起的卡头上的草稿标记。手机草稿按“设备、经理、议题”分几份文件存（与 Issue 同一个键）：
// 选项 manager-choices.json、补充说明或回复 manager-replies.json、追问 manager-questions.json，
// 草稿开始写时的版本 manager-draft-revisions.json。这里只读，判断规则用 core 的 managerDraftMark。

import {
  type ManagerDraftBoard,
  type ManagerDraftMark,
  managerDraftMark,
} from '../../../../../packages/core/src/projection/manager-drafts.mts'
import type { ManagerObjectHead } from '../../../../../packages/protocol/src/manager-paging.mts'
import { baseFile, choiceFile, questionFile, replyFile } from './draft-files'

/** 一页卡头的草稿标记，文件每次只读一遍 */
export function draftMarks(
  board: ManagerDraftBoard,
  address: { deviceId: string; managerId: string },
  heads: readonly Pick<ManagerObjectHead, 'id' | 'kind' | 'revision'>[],
): Map<string, ManagerDraftMark> {
  const choices = choiceFile.read() ?? {}
  const replies = replyFile.read() ?? {}
  const questions = questionFile.read() ?? {}
  const bases = baseFile.read() ?? {}
  const marks = new Map<string, ManagerDraftMark>()
  for (const head of heads) {
    const key = JSON.stringify([address.deviceId, address.managerId, head.id])
    const revision = bases[key] ?? head.revision
    const text = replies[key] ?? ''
    const question = questions[key] ?? ''
    const mark = managerDraftMark(
      board,
      head.id,
      head.kind === 'decision'
        ? {
            decision: {
              decisionId: head.id,
              revision,
              optionId: choices[key] ?? null,
              text,
              question,
            },
          }
        : {
            ...(head.kind === 'request'
              ? { request: { requestId: head.id, revision, delivered: false, text } }
              : {}),
            post: { id: head.id, revision, question },
          },
    )
    if (mark) marks.set(head.id, mark)
  }
  return marks
}
