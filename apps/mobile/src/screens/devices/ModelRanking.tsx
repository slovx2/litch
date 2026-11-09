import { keys, type ModelRankingSnapshot, moveRankedModel } from '@litch/core'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { useLeaveGuard } from './hconfig/leave'

export function ModelRanking({ deviceId }: { deviceId: string }) {
  const channel = useChannel(),
    t = useT(),
    theme = useTheme()
  const latest = useKey<ModelRankingSnapshot>(keys.modelRanking(deviceId))
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ModelRankingSnapshot | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [reset, setReset] = useState(false)
  useEffect(() => {
    if (latest && !dirty) setDraft(latest)
  }, [latest, dirty])
  const leave = useLeaveGuard(dirty)
  const request = async (action: 'read' | 'write' | 'reset') => {
    setBusy(true)
    setFailure(null)
    try {
      const result =
        action === 'read'
          ? await channel.command('device.modelRanking.read', { deviceId })
          : action === 'reset'
            ? await channel.command('device.modelRanking.reset', {
                deviceId,
                expectedRevision: draft?.revision ?? 0,
              })
            : draft &&
              (await channel.command('device.modelRanking.write', {
                deviceId,
                expectedRevision: draft.revision,
                tiers: draft.tiers,
                unranked: draft.unranked,
                models: draft.models,
                manual: draft.manual ?? [],
              }))
      if (result) {
        setDraft(result)
        setDirty(false)
        setSelected(null)
        setReset(false)
      }
      return Boolean(result)
    } catch (error) {
      setFailure(error)
      return false
    } finally {
      setBusy(false)
    }
  }
  leave.current = () => request('write')
  const move = (target: number | null, separate = false) => {
    if (!selected || !draft) return
    setDraft({ ...draft, ...moveRankedModel(draft, selected, target, separate) })
    setDirty(true)
    setSelected(null)
  }
  const group = (members: string[], level: number | null) => (
    <View
      key={level ?? 'unranked'}
      style={{
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: theme.c.line2,
        borderRadius: theme.radius.s,
      }}
    >
      <Text style={{ color: theme.c.ink }}>
        {level === null ? t('ranking.unranked') : t('ranking.level', { level: level + 1 })}
      </Text>
      {members.map((key) => {
        const model = draft?.models.find((entry) => entry.key === key)
        if (!model) return null
        return (
          <View key={key} style={{ gap: 4 }}>
            <Text style={{ color: theme.c.ink }}>
              {model.name} · {model.harness}
              {model.available ? '' : ` · ${t('ranking.unavailable')}`}
            </Text>
            <Button label={t('ranking.move')} disabled={busy} onPress={() => setSelected(key)} />
          </View>
        )
      })}
    </View>
  )
  return (
    <View testID="model-ranking" style={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.c.ink }}>{t('ranking.title')}</Text>
      <Button
        label={t(open ? 'ranking.close' : 'ranking.open')}
        disabled={busy}
        onPress={() => {
          setOpen(!open)
          if (!open && !dirty) void request('read')
        }}
      />
      {open && (
        <>
          <Text style={{ color: theme.c.ink2 }}>{t('ranking.note')}</Text>
          {failure != null && (
            <Text accessibilityRole="alert" style={{ color: theme.c.err }}>
              {whyNot(failure, t)}
            </Text>
          )}
          {draft && (
            <>
              <Text style={{ color: theme.c.ink2 }}>
                {t(draft.mode === 'custom' ? 'ranking.custom' : 'ranking.builtin')}
                {dirty ? ` · ${t('ranking.unsaved')}` : ''}
              </Text>
              {Object.keys(draft.errors).length > 0 && (
                <Text style={{ color: theme.c.ink2 }}>
                  {t('ranking.partial')}: {Object.keys(draft.errors).join(', ')}
                </Text>
              )}
              {selected && (
                <View style={{ gap: 8 }}>
                  {draft.tiers.map((tier, index) => (
                    <Button
                      key={tier.join()}
                      label={t('ranking.level', { level: index + 1 })}
                      onPress={() => move(index)}
                    />
                  ))}
                  <Button label={t('ranking.new')} onPress={() => move(draft.tiers.length, true)} />
                  <Button label={t('ranking.unranked')} onPress={() => move(null)} />
                  <Button label={t('ranking.cancel')} onPress={() => setSelected(null)} />
                </View>
              )}
              {draft.tiers
                .map((members, level) => ({ members, level }))
                .reverse()
                .map(({ members, level }) => group(members, level))}
              {group(draft.unranked, null)}
              {draft.unranked.length > 0 && (
                <Text style={{ color: theme.c.ink2 }}>{t('ranking.unknownNote')}</Text>
              )}
              <Button
                label={t('ranking.save')}
                disabled={busy}
                onPress={() => void request('write')}
              />
              <Button label={t('ranking.reset')} disabled={busy} onPress={() => setReset(true)} />
              {reset && (
                <>
                  <Text style={{ color: theme.c.ink2 }}>{t('ranking.resetNote')}</Text>
                  <Button
                    label={t('ranking.reset')}
                    disabled={busy}
                    onPress={() => void request('reset')}
                  />
                  <Button label={t('ranking.cancel')} onPress={() => setReset(false)} />
                </>
              )}
            </>
          )}
          <Button
            label={t('ranking.refresh')}
            disabled={busy}
            onPress={() => void request('read')}
          />
        </>
      )}
    </View>
  )
}
