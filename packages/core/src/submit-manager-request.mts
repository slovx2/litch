// 卡片上的响应按钮只提交这一项；批量提交继续由提交条负责。
import type { CoreChannel } from './channel/client.mjs'
import type { ManagerRequestView, ManagerSubmittedRequest } from './model-manager.mjs'

export async function submitManagerRequest(
  channel: Pick<CoreChannel, 'command'>,
  deviceId: string,
  managerId: string,
  request: ManagerSubmittedRequest,
): Promise<ManagerRequestView | null> {
  const result = await channel.command('managers.feedback.submit', {
    deviceId,
    managerId,
    answers: [],
    questions: [],
    requests: [request],
  })
  const rejected = result.rejectedRequests.find((entry) => entry.requestId === request.requestId)
  if (rejected) throw new Error(rejected.message)
  return result.acceptedRequests.find((entry) => entry.id === request.requestId) ?? null
}
