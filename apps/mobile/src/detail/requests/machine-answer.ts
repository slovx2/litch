// 先核对手机实际显示的预览，再用已有的配对钥匙签答复。
import {
  isMachineApprovalReview,
  isMachinePhoneAnswer,
  type MachineApprovalCard,
  type MachinePhoneAnswer,
  type MachinePhoneDecision,
  machineApprovalPayload,
  machineApprovalSignedText,
} from '../../../../../packages/protocol/src/machine-approvals.mts'

export async function buildMachineAnswer(
  card: MachineApprovalCard,
  decision: MachinePhoneDecision,
  phoneId: string,
  hash: (value: string) => Promise<string>,
  sign: (value: string) => Promise<string>,
  now = Date.now,
): Promise<MachinePhoneAnswer | null> {
  const review = card.review
  if (
    !isMachineApprovalReview(review) ||
    card.expiresAt <= now() ||
    (await hash(machineApprovalPayload(card, review))) !== review.payloadHash
  )
    return null
  const { id, threadId, expiresAt } = card
  const { desktopId, nonce, version, payloadHash } = review
  const proof = {
    id,
    threadId,
    expiresAt,
    desktopId,
    nonce,
    version,
    payloadHash,
    phoneId,
    ...decision,
  }
  const answer = { ...proof, signature: await sign(machineApprovalSignedText(proof)) }
  return isMachinePhoneAnswer(answer) && expiresAt > now() ? answer : null
}
