// 飞书应用详情里的“私聊绑定”一节：配对码输入加“查找”，查到的人带请求时间与剩余时间，确认后绑定；
// 下面每个绑定一行（名字、创建者、审批人、绑定或撤销时间、保留天数），右上角小字是用户身份授权的状态，
// 失败、失效的原因写在第二行开头。点一行出动作单：审批人开关、改保留天数、授权用户身份或撤销授权、撤销绑定；
// 授权的次要信息（授权时间、最近使用、权限数）写在动作单的说明里。授权进行中时行下面一小块显示链接和用户码
// （都能复制）与有效期。发起、撤销授权都先确认。
// 已撤销的只能改保留天数。写操作带 expectedRevision，冲突或绑定已在别处变了时重读这一应用的绑定并提示重试；
// 命令结果与重读到的先合进列表（revision 大的为准），不等快照。
import * as Clipboard from 'expo-clipboard'
import { useCallback, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { operationId } from '../../../../../../packages/ui/src/external/model.ts'
import { feishuFailure, grantFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  grantDetailText,
  grantErrorText,
  grantLinkLeftText,
  grantStateText,
} from '../../../../../../packages/ui/src/feishu/grant-text.ts'
import {
  bindingIsCreator,
  bindingName,
  boundedInt,
  canInviteGrant,
  canRevokeGrant,
  FEISHU_RETENTION_DAYS,
  type FeishuApp,
  type FeishuBinding,
  type FeishuPairing,
  type FeishuUserGrant,
  feishuReason,
  grantFail,
  grantFor,
  grantLinkLive,
  grantStale,
  mergeBindings,
  mergeGrants,
  pairingCode,
  pairingCodeBad,
  sortBindings,
  staleReason,
  timeLeft,
  userIdentityMissing,
  type WriteBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import { timeLeftText } from '../../../../../../packages/ui/src/feishu/speech-text.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Row, SectionLabel } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { Confirm, Prompt, Sheet, type SheetAction } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'
import { useFeishuBindings } from './use-feishu'

/** 一个能复制的值：标签、值（单行截断）、复制按钮；复制后按钮短暂变成对勾 */
function CopyField({
  label,
  value,
  shown,
  copyLabel,
  mono,
  testID,
}: {
  label: string
  value: string
  shown: string
  copyLabel: string
  mono?: boolean
  testID: string
}) {
  const { c, font } = useTheme()
  const [copied, setCopied] = useState(false)
  return (
    <View style={styles.copyField}>
      <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{label}</Text>
      <Text
        numberOfLines={1}
        selectable
        style={[
          styles.shrink,
          { color: c.ink, fontSize: font.size.meta, fontFamily: font.mono },
          mono ? { fontWeight: '600' } : null,
        ]}
      >
        {shown}
      </Text>
      <IconButton
        icon={copied ? 'check' : 'copy'}
        label={copyLabel}
        size={14}
        testID={testID}
        style={styles.copy}
        onPress={() => {
          void Clipboard.setStringAsync(value).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            () => {},
          )
        }}
      />
    </View>
  )
}

/**
 * 授权进行中：给本人的链接和用户码与有效期。链接不做成可点的：
 * 在这台手机上打开会以 Litch 使用者的飞书账号同意，不是本人
 */
function GrantLink({ grant, now }: { grant: FeishuUserGrant; now: number }) {
  const t = useT()
  const { c, font } = useTheme()
  const pending = grant.pending
  if (!pending) return null
  const live = grantLinkLive(grant, now)
  return (
    <View
      testID={`feishu:grant:link:${grant.openId}`}
      style={[styles.link, { backgroundColor: c.panel, borderBottomColor: c.line1 }]}
    >
      <CopyField
        label={t('feishu.grant.link')}
        value={pending.verificationUrl}
        shown={pending.verificationUrl.replace(/^https:\/\//u, '')}
        copyLabel={t('feishu.grant.copyLink')}
        testID={`feishu:grant:copy-link:${grant.openId}`}
      />
      <CopyField
        label={t('feishu.grant.code')}
        value={pending.userCode}
        shown={pending.userCode}
        copyLabel={t('feishu.grant.copyCode')}
        mono
        testID={`feishu:grant:copy-code:${grant.openId}`}
      />
      <Text style={{ color: live ? c.ink3 : c.err, fontSize: font.size.meta }}>
        {grantLinkLeftText(t, pending, now)}
        {live ? ` · ${t('feishu.grant.linkNote')}` : ''}
      </Text>
    </View>
  )
}

export function FeishuBindings({
  deviceId,
  app,
  block,
}: {
  deviceId: string
  app: FeishuApp
  /** 写操作为什么不能做；null 是能做 */
  block: WriteBlock
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const channel = useChannel()
  const appId = app.appId
  const view = useFeishuBindings(deviceId, appId)
  /** 命令结果和冲突后重读到的绑定 */
  const [fresh, setFresh] = useState<FeishuBinding[]>([])
  const [code, setCode] = useState('')
  const [found, setFound] = useState<{ code: string; pairing: FeishuPairing } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [findError, setFindError] = useState('')
  const [error, setError] = useState('')
  /** 点开的那一行（动作单）、在改保留天数的、在确认撤销的 */
  const [open, setOpen] = useState<FeishuBinding | null>(null)
  const [editing, setEditing] = useState<FeishuBinding | null>(null)
  const [revoking, setRevoking] = useState<FeishuBinding | null>(null)
  /** 授权命令的结果和重读到的授权；在确认发起授权的、在确认撤销授权的 */
  const [freshGrants, setFreshGrants] = useState<FeishuUserGrant[]>([])
  const [inviting, setInviting] = useState<FeishuBinding | null>(null)
  const [ungranting, setUngranting] = useState<FeishuBinding | null>(null)

  const refetch = useCallback(() => {
    channel.command('feishu.binding.list', { deviceId, appId }).then(
      (result) => setFresh(result.bindings),
      () => {},
    )
    channel.command('feishu.grant.list', { deviceId, appId }).then(
      (result) => setFreshGrants(result.grants),
      () => {},
    )
  }, [channel, deviceId, appId])
  const keep = (binding: FeishuBinding) =>
    setFresh((list) => [...list.filter((one) => one.openId !== binding.openId), binding])
  const keepGrant = (grant: FeishuUserGrant) =>
    setFreshGrants((list) => [...list.filter((one) => one.openId !== grant.openId), grant])
  /** 跑一个写命令：忙记号、失败原因，绑定或授权已在别处变了时先重读。grant 为 true 时按授权的原因代码说 */
  const run = async <R,>(
    what: string,
    request: () => Promise<R>,
    grant = false,
  ): Promise<R | undefined> => {
    setBusy(what)
    setError('')
    try {
      return await request()
    } catch (failed) {
      if (staleReason(feishuReason(failed)) || (grant && grantStale(grantFail(failed)))) refetch()
      setError(grant ? grantFailure(failed, t) : feishuFailure(failed, t))
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const normalized = pairingCode(code)
  const bad = pairingCodeBad(code)
  const lookup = async () => {
    if (!normalized) return
    setFound(null)
    setFindError('')
    setBusy('lookup')
    try {
      const result = await channel.command('feishu.binding.lookup', {
        deviceId,
        appId,
        code: normalized,
      })
      setFound({ code: normalized, pairing: result.pairing })
    } catch (failed) {
      setFindError(feishuFailure(failed, t))
    } finally {
      setBusy(null)
    }
  }
  const approve = async () => {
    if (!found) return
    const result = await run('approve', () =>
      channel.command('feishu.binding.approve', { deviceId, appId, code: found.code }),
    )
    if (!result) return
    keep(result.binding)
    setFound(null)
    setCode('')
  }
  const update = async (
    binding: FeishuBinding,
    patch: { approver?: boolean; retentionDays?: number },
  ) => {
    const result = await run(binding.openId, () =>
      channel.command('feishu.binding.update', {
        deviceId,
        appId,
        openId: binding.openId,
        expectedRevision: binding.revision,
        ...patch,
      }),
    )
    if (result) keep(result.binding)
  }
  const revoke = async (binding: FeishuBinding) => {
    const result = await run(binding.openId, () =>
      channel.command('feishu.binding.revoke', {
        deviceId,
        appId,
        openId: binding.openId,
        expectedRevision: binding.revision,
      }),
    )
    if (result) keep(result.binding)
  }
  const invite = async (binding: FeishuBinding) => {
    const result = await run(
      binding.openId,
      () =>
        channel.command('feishu.grant.invite', {
          deviceId,
          appId,
          openId: binding.openId,
          operationId: operationId(),
        }),
      true,
    )
    if (result) keepGrant(result.grant)
  }
  const ungrant = async (binding: FeishuBinding) => {
    const result = await run(
      binding.openId,
      () => channel.command('feishu.grant.revoke', { deviceId, appId, openId: binding.openId }),
      true,
    )
    if (result) keepGrant(result.grant)
  }

  const latest = view?.value?.bindings ?? null
  const rows = latest ? sortBindings(mergeBindings(latest, fresh)) : null
  const grants = mergeGrants(view?.value?.grants ?? [], freshGrants)
  /** 撤销了绑定的人授权随之撤销，不再显示授权 */
  const grantOf = (binding: FeishuBinding) =>
    binding.state === 'bound' ? grantFor(grants, binding.openId) : null
  const snapshotError = view?.error ?? null
  const denied =
    block === 'readOnly' ? t('feishu.readOnly') : block ? t('feishu.offline') : undefined
  const now = Date.now()
  const left = found ? timeLeft(found.pairing.expiresAt, now) : null
  const pending = app.pendingPairings ?? 0
  const meta = { color: c.ink3, fontSize: font.size.meta }
  const note = [styles.note, meta]
  const range = t('feishu.chat.range', {
    min: FEISHU_RETENTION_DAYS.min,
    max: FEISHU_RETENTION_DAYS.max,
  })

  const detail = (binding: FeishuBinding) => {
    const revoked = binding.state === 'revoked'
    const at = ((revoked ? binding.revokedAt : null) ?? binding.boundAt) * 1000
    return [
      revoked ? '' : (grantErrorText(t, grantOf(binding)) ?? ''),
      bindingIsCreator(binding, app) ? t('feishu.binding.creator') : '',
      revoked ? '' : binding.approver ? t('feishu.binding.approver') : '',
      t(revoked ? 'feishu.binding.revokedAt' : 'feishu.binding.boundAt', {
        time: stamp(at, now, t.lang),
      }),
      t('feishu.binding.days', { n: binding.retentionDays }),
    ]
      .filter(Boolean)
      .join(' · ')
  }
  /** 动作单的说明：授权状态与次要信息，再接审批人的说明 */
  const sheetNote = (binding: FeishuBinding) => {
    const grant = grantOf(binding)
    const line = [
      `${t('feishu.grant.label')} · ${grantStateText(t, grant)}`,
      grantErrorText(t, grant),
      grantDetailText(t, grant, now),
    ]
      .filter(Boolean)
      .join(' · ')
    return `${line}\n${t('feishu.binding.approverNote')}`
  }
  const actions = (binding: FeishuBinding): SheetAction[] => {
    const why = denied ? { disabled: denied } : {}
    const list: SheetAction[] = []
    if (binding.state === 'bound')
      list.push({
        label: t('feishu.binding.approver'),
        checked: binding.approver,
        testID: 'feishu:binding:approver',
        ...why,
        onPress: () => void update(binding, { approver: !binding.approver }),
      })
    list.push({
      label: t('feishu.binding.retention'),
      value: String(binding.retentionDays),
      testID: 'feishu:binding:retention',
      afterDismiss: true,
      ...why,
      onPress: () => setEditing(binding),
    })
    const grant = grantOf(binding)
    if (binding.state === 'bound' && canInviteGrant(grant, now))
      list.push({
        label: t('feishu.grant.invite'),
        testID: 'feishu:grant:invite',
        afterDismiss: true,
        ...why,
        onPress: () => setInviting(binding),
      })
    else if (binding.state === 'bound' && canRevokeGrant(grant))
      list.push({
        label: t('feishu.grant.revoke'),
        danger: true,
        testID: 'feishu:grant:revoke',
        afterDismiss: true,
        ...why,
        onPress: () => setUngranting(binding),
      })
    if (binding.state === 'bound')
      list.push({
        label: t('feishu.binding.revoke'),
        danger: true,
        testID: 'feishu:binding:revoke',
        afterDismiss: true,
        ...why,
        onPress: () => setRevoking(binding),
      })
    return list
  }

  return (
    <View testID="feishu:bindings">
      <SectionLabel
        right={
          pending > 0 ? (
            <Text testID="feishu:bindings:pending" style={[meta, { color: c.wait }]}>
              {t('feishu.binding.pending', { n: pending })}
            </Text>
          ) : undefined
        }
      >
        {t('feishu.binding.title')}
      </SectionLabel>
      <Text style={note}>{t('feishu.binding.note')}</Text>
      <View style={styles.find}>
        <TextInput
          accessibilityLabel={t('feishu.binding.code')}
          value={code}
          onChangeText={(text) => {
            setCode(text)
            setFound(null)
            setFindError('')
          }}
          placeholder="ABCD-EFGH"
          placeholderTextColor={c.ink3}
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          maxLength={12}
          editable={block === null}
          returnKeyType="search"
          onSubmitEditing={() => void lookup()}
          testID="feishu:pairing:code"
          style={[
            styles.input,
            {
              color: c.ink,
              fontFamily: font.mono,
              backgroundColor: c.raised,
              borderColor: bad ? c.err : c.line2,
              borderRadius: theme.radius.m,
              minHeight: theme.hit,
              opacity: block === null ? 1 : 0.5,
            },
          ]}
        />
        <Button
          kind="plain"
          label={t('feishu.binding.lookup')}
          testID="feishu:pairing:lookup"
          busy={busy === 'lookup'}
          disabled={block !== null || !normalized || busy !== null}
          onPress={() => void lookup()}
        />
      </View>
      {block === 'readOnly' ? <Text style={note}>{t('feishu.readOnly')}</Text> : null}
      {bad ? (
        <Text style={[styles.note, { color: c.err }]}>{t('feishu.binding.codeBad')}</Text>
      ) : null}
      {findError ? (
        <Text testID="feishu:pairing:error" style={[styles.note, { color: c.err }]}>
          {findError}
        </Text>
      ) : null}
      {found ? (
        <View
          testID="feishu:pairing"
          style={[styles.found, { borderColor: c.line2, borderRadius: theme.radius.m }]}
        >
          <Text numberOfLines={1} style={{ color: c.ink, fontWeight: '600' }}>
            {bindingName(found.pairing)}
          </Text>
          <Text numberOfLines={1} style={[meta, { fontFamily: font.mono }]}>
            {found.pairing.openId}
          </Text>
          <Text style={meta}>
            {t('feishu.binding.requested', {
              time: stamp(found.pairing.createdAt * 1000, now, t.lang),
            })}
            {' · '}
            <Text style={left ? null : { color: c.err }}>
              {left ? timeLeftText(t, left) : t('feishu.binding.expired')}
            </Text>
          </Text>
          <View style={styles.buttons}>
            <Button
              label={t('feishu.binding.approve')}
              testID="feishu:pairing:approve"
              busy={busy === 'approve'}
              disabled={block !== null || busy !== null || !left}
              onPress={() => void approve()}
            />
            <Button kind="plain" label={t('feishu.cancel')} onPress={() => setFound(null)} />
          </View>
        </View>
      ) : null}
      {snapshotError ? (
        <Text style={[styles.note, { color: c.err }]}>
          {snapshotError.text ? t.text(snapshotError.text) : snapshotError.message}
        </Text>
      ) : null}
      {error ? (
        <Text testID="feishu:bindings:error" style={[styles.note, { color: c.err }]}>
          {error}
        </Text>
      ) : null}
      {rows === null && !snapshotError ? <Text style={note}>{t('feishu.loading')}</Text> : null}
      {rows?.length === 0 ? <Text style={note}>{t('feishu.binding.none')}</Text> : null}
      {(rows ?? []).map((binding) => {
        const grant = grantOf(binding)
        return (
          <View key={binding.openId}>
            <Row
              testID={`feishu:binding:${binding.openId}`}
              title={bindingName(binding)}
              detail={detail(binding)}
              meta={
                binding.state === 'revoked' ? t('feishu.binding.revoked') : grantStateText(t, grant)
              }
              trail="none"
              onPress={() => setOpen(binding)}
            />
            {grant?.pending ? <GrantLink grant={grant} now={now} /> : null}
          </View>
        )
      })}
      <Sheet
        visible={open !== null}
        title={open ? bindingName(open) : undefined}
        {...(open?.state === 'bound' ? { note: sheetNote(open) } : {})}
        actions={open ? actions(open) : []}
        onClose={() => setOpen(null)}
      />
      <Prompt
        visible={editing !== null}
        title={t('feishu.binding.retention')}
        initial={editing ? String(editing.retentionDays) : ''}
        note={range}
        maxLength={6}
        submitLabel={t('feishu.chat.save')}
        onSubmit={(value) => {
          const days = boundedInt(value, FEISHU_RETENTION_DAYS)
          if (!editing) return
          if (days === null) setError(range)
          else void update(editing, { retentionDays: days })
        }}
        onClose={() => setEditing(null)}
      />
      <Confirm
        visible={revoking !== null}
        title={t('feishu.binding.revoke.title', { name: revoking ? bindingName(revoking) : '' })}
        detail={t('feishu.binding.revoke.note')}
        confirmLabel={t('feishu.binding.revoke')}
        danger
        onConfirm={() => {
          if (revoking) void revoke(revoking)
        }}
        onClose={() => setRevoking(null)}
      />
      <Confirm
        visible={inviting !== null}
        title={t('feishu.grant.invite.title', { name: inviting ? bindingName(inviting) : '' })}
        detail={[
          t('feishu.grant.invite.note', { name: inviting ? bindingName(inviting) : '' }),
          userIdentityMissing(app.capability) ? t('feishu.grant.invite.prereq') : '',
        ]
          .filter(Boolean)
          .join('\n\n')}
        confirmLabel={t('feishu.grant.invite.yes')}
        onConfirm={() => {
          if (inviting) void invite(inviting)
        }}
        onClose={() => setInviting(null)}
      />
      <Confirm
        visible={ungranting !== null}
        title={t('feishu.grant.revoke.title', {
          name: ungranting ? bindingName(ungranting) : '',
        })}
        detail={t('feishu.grant.revoke.note')}
        confirmLabel={t('feishu.grant.revoke')}
        danger
        onConfirm={() => {
          if (ungranting) void ungrant(ungranting)
        }}
        onClose={() => setUngranting(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  find: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  input: { flex: 1, minWidth: 0, borderWidth: 1, paddingHorizontal: 10, fontSize: 15 },
  found: { marginHorizontal: 16, marginVertical: 4, padding: 12, gap: 2, borderWidth: 1 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8 },
  shrink: { flexShrink: 1 },
  link: {
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  copyField: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  copy: { marginVertical: -8 },
})
