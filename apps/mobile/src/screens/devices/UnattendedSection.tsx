// 设备详情的“无人值守”一节：每个仓库一行状态与待分拣数，本连接 access 允许时可暂停、恢复采集；
// 开机自启、GitHub 身份、经理分配只读一行，配置改动在桌面或 litch config。
import { type DeviceView, keys, type ManagerView } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  allowed,
  operationId,
  repoLabel,
  sourceState,
} from '../../../../../packages/ui/src/external/model.ts'
import { useChannel, useReplica } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { SectionLabel } from '../../ui/kit/controls'
import { IconButton } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'
import { failureText, reasonLabel } from '../managers/external/labels'
import { ManagerRecovery } from '../managers/external/ManagerRecovery'
import { MissingResultReplies } from '../managers/external/MissingResultReply'
import { useExternalDevice } from '../managers/external/use-external'
import { InfoLine } from './parts'

const notificationProblems = new Set([
  'github_notifications_scope_required',
  'github_notifications_access_denied',
  'github_notifications_unavailable',
  'github_notifications_rate_limited',
])

export function UnattendedSection({ device }: { device: DeviceView }) {
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const replica = useReplica()
  const view = useExternalDevice(device.id, device.externalSources === true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (!device.externalSources || !view) return null
  const online = view.sources.online
  const sources = view.sources.value ?? []
  const autostart = view.autostart.value
  const config = view.configuration?.value
  const loginOf = (identityId: string | null) =>
    config?.identities.find((one) => one.identityId === identityId)?.login ?? identityId ?? ''
  const assignments = (config?.assignments ?? []).filter((one) => one.identityId)
  const toggle = async (sourceId: string, revision: number, paused: boolean) => {
    setBusy(sourceId)
    setError('')
    try {
      await channel.command(paused ? 'external.source.resume' : 'external.source.pause', {
        deviceId: device.id,
        sourceId,
        expectedRevision: revision,
        operationId: operationId(),
      })
    } catch (failed) {
      setError(failureText(t, failed))
    } finally {
      setBusy(null)
    }
  }
  return (
    <View testID="detail:unattended">
      <SectionLabel>{t('mgh.unattended')}</SectionLabel>
      {!online ? (
        <Text style={[styles.note, { color: c.ink3 }]}>{t('external.offline')}</Text>
      ) : null}
      {view.sources.value && sources.length === 0 ? (
        <Text style={[styles.note, { color: c.ink3 }]}>{t('mgh.source.none')}</Text>
      ) : null}
      {sources.map((status) => {
        const repo = status.source.repos[0]
        const state = sourceState(status)
        const paused = state === 'paused'
        const pending = status.runtime?.backlog.pending ?? 0
        const notification = status.readiness?.collect.diagnostics.find((item) =>
          notificationProblems.has(item.code),
        )
        const can = online && allowed(view.access, paused ? 'resumeSource' : 'pauseSource')
        return (
          <View
            key={status.source.sourceId}
            style={styles.row}
            testID={`unattended-source:${status.source.sourceId}`}
          >
            <View style={styles.main}>
              <Text numberOfLines={1} style={{ color: c.ink, fontSize: font.size.body }}>
                {repo ? repoLabel(repo) : status.source.sourceId}
              </Text>
              <Text
                style={{ color: state === 'blocked' ? c.err : c.ink3, fontSize: font.size.meta }}
              >
                {t(`mgh.source.${state}` as Key)}
                {pending ? ` · ${t('mgh.source.pending', { n: pending })}` : ''}
              </Text>
              {notification ? (
                <Text style={{ color: c.err, fontSize: font.size.meta }}>
                  {t(`mgh.source.${notification.code}` as Key)}
                </Text>
              ) : null}
              {status.missingResultReplies?.length ? (
                <MissingResultReplies replies={status.missingResultReplies} />
              ) : null}
              {status.readiness?.notify.diagnostics
                .filter(({ state }) => state === 'blocked')
                .map((item, index) => (
                  <View key={item.recovery?.managerId ?? index} style={styles.blocked}>
                    <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
                      {reasonLabel(t, item.code)}
                    </Text>
                    {item.recovery ? (
                      <ManagerRecovery
                        deviceId={device.id}
                        recovery={item.recovery}
                        disabled={!online}
                      />
                    ) : null}
                  </View>
                ))}
            </View>
            {can ? (
              <IconButton
                icon={paused ? 'play' : 'pause'}
                label={t(paused ? 'mgh.source.resume' : 'mgh.source.pause')}
                busy={busy === status.source.sourceId}
                testID={`unattended-toggle:${status.source.sourceId}`}
                onPress={() => void toggle(status.source.sourceId, status.source.revision, paused)}
              />
            ) : null}
          </View>
        )
      })}
      {error ? <Text style={[styles.note, { color: c.err }]}>{error}</Text> : null}
      {autostart ? (
        <InfoLine
          label={t('mgh.autostart')}
          value={
            t(`mgh.autostart.${autostart.state}` as Key) +
            (autostart.state === 'enabled' && autostart.requiresLogin
              ? ` · ${t('mgh.autostart.login')}`
              : '')
          }
        />
      ) : null}
      {config ? (
        <InfoLine
          label={t('mgh.identities')}
          value={config.identities.map((one) => one.login).join(', ') || t('mgh.none')}
        />
      ) : null}
      {config ? (
        <InfoLine
          label={t('mgh.assignments')}
          value={
            assignments
              .map((one) => {
                const name =
                  replica.store.get<ManagerView>(keys.manager(device.id, one.managerId))?.name ??
                  one.managerId
                return `${name} · ${t('mgh.assignment.line', {
                  identity: loginOf(one.identityId),
                  count: one.repoIds.length,
                })}`
              })
              .join('\n') || t('mgh.none')
          }
        />
      ) : null}
      <Text style={[styles.note, { color: c.ink3, fontSize: font.size.meta }]}>
        {t('mgh.edit')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  // 一个来源可能有好几行状态，暂停按钮贴着仓库名那一行，不随内容高度居中
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 16, paddingRight: 8 },
  main: { flex: 1, paddingVertical: 10, gap: 2 },
  blocked: { gap: 2 },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 6 },
})
