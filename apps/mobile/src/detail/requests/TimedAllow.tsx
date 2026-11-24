// 审批卡上的“限时允许”（手机）：点开一行选时长（常用值或自己填），确认后授予这个会话这一类（MCP 再按服务）的限时授权。
// 授予后卡片不用再答：原生审批由会话所在设备一并代答，卡片随之消失。
import {
  type RequestView,
  TIMED_APPROVAL_MAX_HOURS,
  TIMED_APPROVAL_MIN_HOURS,
  TIMED_APPROVAL_PRESETS,
  timedTargetOf,
  validTimedApprovalHours,
} from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { CardTextInput } from '../../ui/kit/KeyboardCardScrollView'
import { useTheme } from '../../ui/theme'
import { timedWhat, untilText, useTimedApprovals } from '../timed/timed'
import { CardButton } from './Card'

const DEFAULT_HOURS = 4

export function useTimedAllow(props: {
  deviceId: string
  sessionId: string
  request: RequestView
  disabled: boolean
}) {
  const { deviceId, sessionId, request, disabled } = props
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const view = useTimedApprovals(deviceId)
  const target = timedTargetOf(request)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(String(DEFAULT_HOURS))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const what = target ? timedWhat(t, target) : null
  if (!target || !what || !view?.available) return { button: null, panel: null, open: false }

  const hours = Number(text)
  const valid = text.trim() !== '' && validTimedApprovalHours(hours)
  const now = Date.now()
  const grant = () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    channel
      .command('timedApproval.grant', {
        deviceId,
        threadId: sessionId,
        category: target.category,
        ...(target.scope ? { scope: target.scope } : {}),
        hours,
      })
      .catch((failure: unknown) => {
        setBusy(false)
        setError(t('timed.failed', { reason: whyNot(failure, t) }))
      })
  }

  const button = (
    <CardButton
      kind="ghost"
      symbol="clock"
      testID="request:timed"
      label={t('timed.open')}
      disabled={disabled || busy}
      onPress={() => setOpen(!open)}
    />
  )
  const panel = open ? (
    <View style={styles.panel} testID="request:timed-panel">
      <View style={styles.row}>
        {TIMED_APPROVAL_PRESETS.map((preset) => (
          <CardButton
            key={preset}
            kind={hours === preset ? 'plain' : 'ghost'}
            testID={`request:timed:${preset}`}
            label={t('timed.preset', { hours: preset })}
            disabled={busy}
            onPress={() => setText(String(preset))}
          />
        ))}
        <View style={styles.hours}>
          <CardTextInput
            value={text}
            onChangeText={setText}
            keyboardType="decimal-pad"
            accessibilityLabel={t('timed.hoursLabel')}
            editable={!busy}
            testID="request:timed-hours"
            style={[
              styles.input,
              {
                color: c.ink,
                borderColor: c.line2,
                backgroundColor: c.panel,
                borderRadius: theme.radius.m,
                minHeight: theme.hit - 4,
              },
            ]}
          />
          <Text style={{ color: c.ink2 }}>{t('timed.hoursUnit')}</Text>
        </View>
      </View>
      <Text style={[styles.hint, { color: valid ? c.ink3 : c.err }]}>
        {valid
          ? t('timed.until', { time: untilText(now + hours * 3_600_000, now, t.lang), what })
          : t('timed.range', { min: TIMED_APPROVAL_MIN_HOURS, max: TIMED_APPROVAL_MAX_HOURS })}
      </Text>
      <CardButton
        kind="primary"
        testID="request:timed-confirm"
        label={t('timed.confirm', { hours: valid ? hours : '—' })}
        disabled={!valid || busy}
        onPress={grant}
      />
      {error ? <Text style={[styles.hint, { color: c.err }]}>{error}</Text> : null}
    </View>
  ) : null
  return { button, panel, open }
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  hours: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { width: 64, borderWidth: 1, paddingHorizontal: 8, fontSize: 15 },
  hint: { fontSize: 12 },
})
