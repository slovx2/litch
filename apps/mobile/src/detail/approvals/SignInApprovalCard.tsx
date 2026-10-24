// 电脑上的代理要登录一个网站，手机上批准（22 号设计第五节、第八节）：排在输入框上面，和别的请求卡片同一个位置、同一个外框。
// 手机上只有“用 {账号} 登录”和“拒绝”（网页在电脑上，自己登录要到电脑上去）。账号只显示打码的名字，答复里用 ref 指。
// 批准前要过系统的指纹、面容或锁屏密码，过了才拿得出批准钥匙签名；拒绝不用过验证（签名照样带）。
// 送出去之后卡片不马上消失：电脑验过签、答完了才收掉；电脑不认（钥匙对不上之类）时卡片还在，可以再点。
import type { ApprovalCardView } from '../../../../../packages/protocol/src/client-approvals.mts'
import { useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  ensureApprovalKey,
  phoneIdFor,
  signWithApprovalKey,
  unlockForApproval,
} from '../../platform/approval-key'
import { phoneNameOf } from '../../platform/pairing'
import { useChannel } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { Card, CardButton, Meta, Why } from '../requests/Card'
import {
  abilityOf,
  buildAnswer,
  knownBlock,
  originParts,
  remainingMs,
  remainingText,
  shownName,
} from './logic'
import { isGone, sendApprovalAnswer } from './source'

/** 有过期时间的卡片每秒重画一次（倒计时、到点置灰） */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return ticking ? now : Date.now()
}

export function SignInApprovalCard({
  deviceId,
  card,
  waiting,
}: {
  deviceId: string
  card: ApprovalCardView
  waiting: number
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const { summary } = card
  const now = useNow(card.expiresAt !== null)
  const ability = abilityOf(card, now)
  const [picked, setPicked] = useState(summary.accounts[0]?.ref ?? null)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const account = summary.accounts.find((each) => each.ref === picked) ?? summary.accounts[0]
  const origin = originParts(summary.origin)

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
            setError(t(unlocked.reason === 'noLock' ? 'approval.fail.noLock' : 'approval.fail.unlock'))
          return
        }
      }
      const signed = await buildAnswer(
        card,
        { ref, remember },
        {
          phoneId,
          phoneName: phoneNameOf(Platform.constants as unknown as Record<string, unknown>, Platform.OS),
          approvalKey: key.approvalKey,
          sign: signWithApprovalKey,
        },
      )
      await sendApprovalAnswer(channel, deviceId, signed)
      setSent(true)
    } catch (failure) {
      setError(isGone(failure) ? t('approval.fail.gone') : t('approval.fail.send', { reason: whyNot(failure, t) }))
    } finally {
      setBusy(false)
    }
  }

  const left = remainingMs(card, now)
  const block = summary.fillBlocked
  return (
    <Card
      testID="request:signIn"
      title={t('approval.title', { domain: origin.main })}
      right={left !== null && left > 0 ? t('approval.remain', { time: remainingText(left) }) : undefined}
      waiting={waiting}
      error={error}
      actions={
        <>
          {ability === 'fill' && account ? (
            <CardButton
              kind="primary"
              testID="request:signIn:approve"
              label={t('approval.signIn', { account: shownName(account.masked) })}
              disabled={busy}
              onPress={() => answer(account.ref)}
            />
          ) : null}
          <CardButton
            kind="ghost"
            testID="request:signIn:decline"
            label={t('approval.decline')}
            disabled={busy || ability === 'expired'}
            onPress={() => answer(null)}
          />
        </>
      }
    >
      <Text style={[styles.origin, { fontFamily: theme.font.mono }]}>
        <Text style={{ color: c.ink3 }}>{origin.lead}</Text>
        <Text style={{ color: c.ink, fontWeight: '700' }}>{origin.main}</Text>
        <Text style={{ color: c.ink3 }}>{origin.tail}</Text>
      </Text>
      {summary.site ? <Meta label={t('approval.site')} value={summary.site} /> : null}
      {summary.reason ? <Why>{`${t('approval.reason')}：${summary.reason}`}</Why> : null}
      <Meta label={t('approval.device')} value={summary.device} />
      {summary.task ? <Meta label={t('approval.task')} value={summary.task.name} /> : null}
      {ability === 'expired' ? <Why tone="err">{t('approval.expired')}</Why> : null}
      {ability === 'noAccount' ? <Why tone="err">{t('approval.noAccount')}</Why> : null}
      {ability === 'blocked' && block ? (
        <Why tone="err">
          {t('approval.blocked', {
            reason: knownBlock(block) ? t(`approval.blocked.${knownBlock(block)}` as Key) : block,
          })}
        </Why>
      ) : null}
      {ability === 'fill' && summary.accounts.length > 1 ? (
        <View accessibilityRole="radiogroup" style={styles.accounts}>
          <Text style={[styles.label, { color: c.ink2 }]}>{t('approval.accounts')}</Text>
          {summary.accounts.map((each) => {
            const on = each.ref === account?.ref
            return (
              <Pressable
                key={each.ref}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                testID={`request:signIn:account:${each.ref}`}
                disabled={busy}
                onPress={() => setPicked(each.ref)}
                style={[styles.row, { minHeight: theme.hit - 8 }]}
              >
                <Text style={{ color: on ? c.accent : c.ink3, fontFamily: theme.font.mono }}>
                  {on ? theme.radio.on : theme.radio.off}
                </Text>
                <Text style={{ color: c.ink, fontFamily: theme.font.mono }}>
                  {shownName(each.masked)}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}
      {ability === 'fill' && summary.task ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: remember }}
          testID="request:signIn:remember"
          disabled={busy}
          onPress={() => setRemember(!remember)}
          style={[styles.row, { minHeight: theme.hit - 8 }]}
        >
          <Text style={{ color: remember ? c.accent : c.ink3, fontFamily: theme.font.mono }}>
            {remember ? theme.check.on : theme.check.off}
          </Text>
          <Text style={[styles.rememberText, { color: c.ink }]}>{t('approval.remember')}</Text>
        </Pressable>
      ) : null}
      {sent ? <Why>{t('approval.sent')}</Why> : <Why>{t('approval.note')}</Why>}
    </Card>
  )
}

const styles = StyleSheet.create({
  origin: { fontSize: 13 },
  accounts: { gap: 2 },
  label: { fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rememberText: { flex: 1, fontSize: 13, lineHeight: 18 },
})
