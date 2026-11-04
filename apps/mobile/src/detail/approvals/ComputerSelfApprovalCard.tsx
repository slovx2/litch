// 自身访问沿用已绑定手机的批准钥匙；档位包含在签名 ref 中，设备服务不能把本次提升为 24 小时。
import { useState } from 'react'
import { Platform } from 'react-native'
import type { ApprovalCardView } from '../../../../../packages/protocol/src/client-approvals.mts'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  ensureApprovalKey,
  phoneIdFor,
  signWithApprovalKey,
  unlockForApproval,
} from '../../platform/approval-key'
import { phoneNameOf } from '../../platform/pairing'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Card, CardButton, Meta, Why } from '../requests/Card'
import { buildAnswer } from './logic'
import { sendApprovalAnswer } from './source'

export function ComputerSelfApprovalCard({
  deviceId,
  card,
  waiting,
}: {
  deviceId: string
  card: Extract<ApprovalCardView, { kind: 'computerSelf' }>
  waiting: number
}) {
  const t = useT()
  const channel = useChannel()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const answer = async (ref: string | null) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const phoneId = await phoneIdFor(deviceId)
      if (!phoneId) return setError(t('approval.fail.noPhone'))
      const key = await ensureApprovalKey()
      if (ref !== null) {
        const unlocked = await unlockForApproval(t('approval.unlock'), t('approval.unlock.cancel'))
        if (!unlocked.ok) {
          if (unlocked.reason !== 'cancel')
            setError(
              t(unlocked.reason === 'noLock' ? 'approval.fail.noLock' : 'approval.fail.unlock'),
            )
          return
        }
      }
      const signed = await buildAnswer(
        card,
        { ref, remember: false },
        {
          phoneId,
          phoneName: phoneNameOf(
            Platform.constants as unknown as Record<string, unknown>,
            Platform.OS,
          ),
          approvalKey: key.approvalKey,
          sign: signWithApprovalKey,
        },
      )
      await sendApprovalAnswer(channel, deviceId, signed)
      setSent(true)
    } catch (cause) {
      setError(t('approval.fail.send', { reason: whyNot(cause, t) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title={t('computerSelf.title')}
      testID="request:computerSelf"
      waiting={waiting}
      error={error}
      actions={
        <>
          {(['once', 'session', 'always', 'decline'] as const).map((choice) => (
            <CardButton
              key={choice}
              symbol={choice === 'decline' ? 'close' : 'check'}
              testID={`request:computerSelf:${choice}`}
              kind={choice === 'decline' ? 'ghost' : 'plain'}
              label={t(
                choice === 'always'
                  ? 'computerSelf.day'
                  : choice === 'decline'
                    ? 'approval.decline'
                    : choice === 'once'
                      ? 'computerSelf.once'
                      : 'computerSelf.session',
              )}
              disabled={busy}
              onPress={() => answer(choice === 'decline' ? null : choice)}
            />
          ))}
        </>
      }
    >
      <Why tone="err">{t('computerSelf.risk')}</Why>
      <Why>{t('computerSelf.phone')}</Why>
      <Meta label={t('approval.device')} value={card.summary.device} />
      {sent ? <Why>{t('approval.sent')}</Why> : null}
    </Card>
  )
}
