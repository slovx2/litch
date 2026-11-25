import { TIMED_APPROVAL_PRESETS, validTimedApprovalHours } from '@litch/core'
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import {
  isMachineApprovalReview,
  type MachineApprovalCard,
  type MachinePhoneDecision,
} from '../../../../../packages/protocol/src/machine-approvals.mts'
import { approvalKeyInfo, phoneIdFor, signWithApprovalKey } from '../../platform/approval-key'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { CardTextInput } from '../../ui/kit/KeyboardCardScrollView'
import { useTheme } from '../../ui/theme'
import { Card, CardButton, Why } from './Card'
import { buildMachineAnswer } from './machine-answer'

// 避免预览中的不可见格式字符改变命令、路径或正文的呈现顺序。
const visible = (text: string) =>
  text.replace(/[\p{Cf}\p{Cc}]/gu, (char) =>
    char === '\n' ? char : `\\u{${char.codePointAt(0)?.toString(16)}}`,
  )

function DeferredMachineCard({
  deviceId,
  card,
  phoneId,
  waiting,
}: {
  deviceId: string
  card: MachineApprovalCard
  phoneId: string | null
  waiting: number
}) {
  const channel = useChannel()
  const theme = useTheme()
  const t = useT()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [timed, setTimed] = useState(false)
  const [text, setText] = useState('4')
  const review = isMachineApprovalReview(card.review) ? card.review : null
  const canAnswer = !!review && !!phoneId
  const hours = Number(text)
  const valid = validTimedApprovalHours(hours)

  const submit = async (decision: MachinePhoneDecision) => {
    if (pending.current || !canAnswer || !phoneId) return
    pending.current = true
    setBusy(true)
    setError(false)
    try {
      const answer = await buildMachineAnswer(
        card,
        decision,
        phoneId,
        (value) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
        signWithApprovalKey,
      )
      if (answer) {
        const result = await channel.command('machine.deferredAnswerSigned', { deviceId, answer })
        if (result.accepted) return
      }
      setError(true)
    } catch {
      setError(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <Card
      title={t(`machine.ask.${card.action}`)}
      testID={`machine-deferred:${card.id}`}
      waiting={waiting}
      error={error ? t('machine.deferred.phoneFailed') : null}
      actions={
        canAnswer && timed ? (
          <>
            <CardButton
              kind="primary"
              label={t('timed.confirm', { hours: valid ? hours : '—' })}
              testID="machine-deferred:confirm"
              disabled={busy || !valid}
              onPress={() => void submit({ decision: 'timed', hours })}
            />
            <CardButton
              kind="ghost"
              label={t('request.back')}
              disabled={busy}
              onPress={() => setTimed(false)}
            />
          </>
        ) : canAnswer ? (
          <>
            <CardButton
              label={t('machine.option.once')}
              testID="machine-deferred:once"
              disabled={busy}
              onPress={() => void submit({ decision: 'once' })}
            />
            <CardButton
              kind="ghost"
              symbol="clock"
              label={t('timed.open')}
              testID="machine-deferred:timed"
              disabled={busy}
              onPress={() => setTimed(true)}
            />
            <CardButton
              kind="ghost"
              label={t('machine.option.decline')}
              testID="machine-deferred:decline"
              disabled={busy}
              onPress={() => void submit({ decision: 'decline' })}
            />
          </>
        ) : null
      }
    >
      <Why>{t('machine.deferred.waiting')}</Why>
      <Why>
        {canAnswer
          ? visible(card.desktop)
          : t('machine.deferred.onMac', { name: visible(card.desktop) })}
      </Why>
      {canAnswer && timed ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {TIMED_APPROVAL_PRESETS.map((preset) => (
              <CardButton
                key={preset}
                label={t('timed.preset', { hours: preset })}
                kind={hours === preset ? 'plain' : 'ghost'}
                disabled={busy}
                onPress={() => setText(String(preset))}
              />
            ))}
          </View>
          <CardTextInput
            value={text}
            onChangeText={setText}
            keyboardType="decimal-pad"
            accessibilityLabel={t('timed.hoursLabel')}
            editable={!busy}
            testID="machine-deferred:hours"
            style={{ color: theme.c.ink, borderColor: theme.c.line2, borderWidth: 1, padding: 8 }}
          />
          <Why>{t('machine.deferred.timedScope')}</Why>
        </View>
      ) : null}
      <Text selectable style={{ color: theme.c.ink, fontFamily: theme.font.mono }}>
        {visible(
          [card.target, ...(card.cwd ? [card.cwd] : []), ...(review ? [review.details] : [])].join(
            '\n',
          ),
        )}
      </Text>
    </Card>
  )
}

export function DeferredMachineCards({
  deviceId,
  sessionId,
}: {
  deviceId: string
  sessionId: string
}) {
  const channel = useChannel()
  const [cards, setCards] = useState<MachineApprovalCard[]>([])
  const [binding, setBinding] = useState<{ deviceId: string; phoneId: string } | null>(null)
  useEffect(() => {
    let active = true
    if (approvalKeyInfo())
      void phoneIdFor(deviceId)
        .then((phoneId) => {
          if (active && phoneId) setBinding({ deviceId, phoneId })
        })
        .catch(() => {})
    const close = channel.subscribe(
      { kind: 'machineApprovals', deviceId },
      { snapshot: setCards, delta: () => {}, error: () => setCards([]) },
    )
    return () => {
      active = false
      close()
    }
  }, [channel, deviceId])
  const mine = cards.filter((card) => card.threadId === sessionId)
  const card = mine[0]
  return card ? (
    <DeferredMachineCard
      key={card.id}
      deviceId={deviceId}
      card={card}
      phoneId={binding?.deviceId === deviceId ? binding.phoneId : null}
      waiting={mine.length - 1}
    />
  ) : null
}
