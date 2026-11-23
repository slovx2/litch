// GitHub 收件条目的底部抽屉：证据（状态、发起人、规则、原因、事件）、外链，和受权时的接单、忽略、改派。
// 并入已有议题只在桌面。可不可以操作只看本连接的 access（缺省即只读），设备仍会复核。
import {
  type ExternalAccess,
  type ExternalInboxEvent,
  type ExternalTriageAction,
  keys,
  type ManagerView,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { ExternalIntake } from '../../../../../../packages/protocol/src/external-sources.mts'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import {
  allowed,
  canTriageAction,
  operationId,
  subjectLabel,
} from '../../../../../../packages/ui/src/external/model.ts'
import { useChannel, useKey, useReplica } from '../../../shell/services'
import { type Key, useT } from '../../../ui/i18n'
import { Button, Field } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { Sheet } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'
import { DiscussionDrawer } from '../DiscussionDrawer'
import { deliveryLabel, failureText, kindLabel, openGithub, reasonLabel, roleLabel } from './labels'
import { ManagerRecovery } from './ManagerRecovery'
import { MissingResultReply } from './MissingResultReply'

type Mode = null | 'accept' | 'ignore'

export function InboxDetail({
  manager,
  head,
  access,
  disabled,
  onClose,
}: {
  manager: ManagerView
  head: ExternalInboxEvent
  access: ExternalAccess | undefined
  disabled: boolean
  onClose(): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const replica = useReplica()
  const { deviceId } = manager
  const [events, setEvents] = useState<ExternalInboxEvent[]>([head])
  const [intake, setIntake] = useState<ExternalIntake | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [reassigning, setReassigning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [fields, setFields] = useState({ title: '', body: '', reason: '', reply: '' })
  /** 同一次处置重试用同一个键，设备按它去重 */
  const attempt = useRef('')
  const managerIds = useKey<string[]>(keys.managerIds(deviceId)) ?? []
  const lookup = head.intakeId ? { intakeId: head.intakeId } : { eventKey: head.eventKey }
  const load = () =>
    channel.command('external.inbox.get', { deviceId, ...lookup }).then(
      (result) => {
        if (result.events.length) setEvents(result.events)
        setIntake(result.intake)
      },
      (error) => setNotice(failureText(t, error)),
    )
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换条目时重读
  useEffect(() => {
    void load()
  }, [head.eventKey, head.intakeId])

  const canTriage =
    !disabled && allowed(access, 'triageInbox') && intake?.status === 'pending_triage'
  const canReassign =
    !disabled && allowed(access, 'reassignInbox') && intake?.status === 'pending_triage'
  useEffect(() => {
    if (!canReassign) setReassigning(false)
  }, [canReassign])
  const others = managerIds
    .filter((id) => id !== manager.id)
    .map((id) => replica.store.get<ManagerView>(keys.manager(deviceId, id)))
    .filter((one): one is ManagerView => one?.status === 'active')

  const open = (next: Mode) => {
    attempt.current = operationId()
    setNotice('')
    setMode(next)
  }
  const submit = async (action: ExternalTriageAction) => {
    if (!intake || disabled || !canTriageAction(access, action.action)) return
    if (!attempt.current) attempt.current = operationId()
    setBusy(true)
    setNotice('')
    try {
      const result = await channel.command('external.inbox.triage', {
        deviceId,
        intakeId: intake.intakeId,
        expectedRevision: intake.revision,
        idempotencyKey: attempt.current,
        ...action,
      })
      attempt.current = ''
      if (result.outcome === 'conflict') {
        setIntake(result.intake)
        setNotice(t('mgh.conflict'))
        return
      }
      if (result.reply && 'notQueued' in result.reply) {
        setIntake(result.intake)
        setMode(null)
        setNotice(t('mgh.replyNotSent', { reason: result.reply.notQueued }))
        return
      }
      onClose()
    } catch (error) {
      setNotice(failureText(t, error))
    } finally {
      setBusy(false)
    }
  }
  const reply = fields.reply.trim() ? { reply: fields.reply.trim() } : {}
  const set = (key: keyof typeof fields) => (value: string) =>
    setFields((now) => ({ ...now, [key]: value }))

  const facts: [string, string][] = [
    [
      t('mgh.field.status'),
      [t(`mgh.status.${head.status}` as Key), head.delivery ? deliveryLabel(t, head.delivery) : '']
        .filter(Boolean)
        .join(' · '),
    ],
    [
      t('mgh.field.actor'),
      head.actorId ? `#${head.actorId} · ${roleLabel(t, head.actorRoleAtCheck)}` : '—',
    ],
    ...(head.ruleId
      ? ([[t('mgh.field.rule'), `${head.ruleId} · v${head.rulesVersion ?? '?'}`]] as [
          string,
          string,
        ][])
      : []),
    ...(head.delivery?.reason || head.reason
      ? ([[t('mgh.field.reason'), reasonLabel(t, head.delivery?.reason ?? head.reason)]] as [
          string,
          string,
        ][])
      : []),
    ...(head.issueId ? ([[t('mgh.field.issue'), head.issueId]] as [string, string][]) : []),
    [t('mgh.field.occurred'), stamp(head.occurredAt * 1000, Date.now(), t.lang)],
  ]

  const footer =
    mode === 'accept' || mode === 'ignore' ? (
      <View style={styles.buttons}>
        <Button kind="quiet" label={t('mgh.form.back')} onPress={() => setMode(null)} />
        <Button
          label={t('mgh.form.submit')}
          busy={busy}
          testID="github-triage-submit"
          disabled={
            !canTriageAction(access, mode) ||
            disabled ||
            (mode === 'accept'
              ? !fields.title.trim() || !fields.body.trim()
              : !fields.reason.trim())
          }
          onPress={() =>
            void submit(
              mode === 'accept'
                ? {
                    action: 'accept',
                    title: fields.title.trim(),
                    body: fields.body.trim(),
                    ...reply,
                  }
                : { action: 'ignore', reason: fields.reason.trim(), ...reply },
            )
          }
        />
      </View>
    ) : canTriage || canReassign ? (
      <View style={styles.buttons}>
        {canTriage ? (
          <Button label={t('mgh.accept')} testID="github-accept" onPress={() => open('accept')} />
        ) : null}
        {canTriage ? (
          <Button
            kind="plain"
            label={t('mgh.ignore')}
            testID="github-ignore"
            onPress={() => open('ignore')}
          />
        ) : null}
        {canReassign ? (
          <Button
            kind="quiet"
            label={t('mgh.reassign')}
            testID="github-reassign"
            onPress={() => setReassigning(true)}
          />
        ) : null}
      </View>
    ) : undefined

  return (
    <DiscussionDrawer
      visible
      id={subjectLabel(head.subject)}
      title={kindLabel(t, head.kind)}
      testID={`github-inbox-detail:${head.eventKey}`}
      stickToEnd={false}
      open={{ label: t('mgh.open'), onPress: () => openGithub(head.eventUrl) }}
      onClose={onClose}
      onBack={onClose}
      footer={footer}
    >
      <View style={styles.body}>
        {facts.map(([label, value]) => (
          <View key={label} style={styles.fact}>
            <Text style={[styles.label, { color: c.ink3, fontSize: font.size.meta }]}>{label}</Text>
            <Text style={[styles.value, { color: c.ink, fontSize: font.size.meta + 1 }]}>
              {value}
            </Text>
          </View>
        ))}
        {head.delivery?.recovery || head.missingResultReply ? (
          // 恢复入口和未回原帖是跟在字段后面的链接，与字段值对齐，不另占整行按钮
          <View style={styles.links}>
            {head.delivery?.recovery ? (
              <ManagerRecovery
                deviceId={deviceId}
                recovery={head.delivery.recovery}
                disabled={disabled}
                onOpen={onClose}
              />
            ) : null}
            {head.missingResultReply ? (
              <MissingResultReply reply={head.missingResultReply} />
            ) : null}
          </View>
        ) : null}
        {events.length > 1 ? (
          <View style={styles.events}>
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
              {t('mgh.field.events')} · {t('mgh.inbox.events', { n: events.length })}
            </Text>
            {events.map((event) => (
              <View key={event.eventKey} style={styles.event}>
                <Text style={{ color: c.ink, flex: 1, fontSize: font.size.meta + 1 }}>
                  {kindLabel(t, event.kind)} · {roleLabel(t, event.actorRoleAtCheck)} ·{' '}
                  {stamp(event.occurredAt * 1000, Date.now(), t.lang)}
                </Text>
                <IconButton
                  icon="external"
                  size={14}
                  label={t('mgh.open')}
                  onPress={() => openGithub(event.eventUrl)}
                />
              </View>
            ))}
          </View>
        ) : null}
        {mode === 'accept' ? (
          <>
            <Field
              editable={canTriage && !busy}
              label={t('mgh.form.title')}
              value={fields.title}
              onChangeText={set('title')}
              testID="github-accept-title"
            />
            <Field
              editable={canTriage && !busy}
              label={t('mgh.form.body')}
              value={fields.body}
              onChangeText={set('body')}
              multiline
              testID="github-accept-body"
            />
          </>
        ) : null}
        {mode === 'ignore' ? (
          <Field
            editable={canTriage && !busy}
            label={t('mgh.form.reason')}
            value={fields.reason}
            onChangeText={set('reason')}
            testID="github-ignore-reason"
          />
        ) : null}
        {mode ? (
          <Field
            editable={canTriage && !busy}
            label={t('mgh.form.reply')}
            value={fields.reply}
            onChangeText={set('reply')}
            multiline
          />
        ) : null}
        {notice ? (
          <Text accessibilityRole="alert" style={{ color: c.err }}>
            {notice}
          </Text>
        ) : null}
      </View>
      <Sheet
        visible={reassigning && canReassign}
        title={t('mgh.reassign.title')}
        {...(others.length ? {} : { note: t('mgh.reassign.none') })}
        onClose={() => setReassigning(false)}
        actions={others.map((one) => ({
          label: one.name,
          testID: `github-reassign:${one.id}`,
          onPress: () => {
            attempt.current = operationId()
            void submit({ action: 'reassign', managerId: one.id })
          },
        }))}
      />
    </DiscussionDrawer>
  )
}

const styles = StyleSheet.create({
  body: { gap: 10, paddingBottom: 8 },
  fact: { flexDirection: 'row', gap: 10, alignItems: 'baseline' },
  label: { width: 64 },
  value: { flex: 1 },
  links: { paddingLeft: 74, gap: 8 },
  events: { gap: 2 },
  event: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
})
