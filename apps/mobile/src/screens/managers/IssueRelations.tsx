import { knownFileRef } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { createContext, useContext, useState } from 'react'
import { Alert, Linking, Pressable, Text, View } from 'react-native'
import type {
  ManagerBoardView,
  ManagerFeaturesView,
  ManagerView,
} from '../../../../../packages/core/src/model-manager.mts'
import { managerRelationGroups } from '../../../../../packages/core/src/projection/manager-relations.mts'
import type { ManagerRelationTarget } from '../../../../../packages/protocol/src/manager-posts.mjs'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

const ICONS = {
  issue: '○',
  item: '▤',
  thread: '↗',
  file: '▱',
  branch: '⑂',
  commit: '◇',
  url: '↗',
} as const
export const IssueContext = createContext<{
  board: ManagerBoardView
  manager: ManagerView
  /** 设备宣告的后加经理能力；没宣告的是比应用旧的设备服务，对应入口禁用并写明原因（与桌面同一套） */
  features: ManagerFeaturesView
  open(id: string): void
} | null>(null)
export function IssueRelations({
  id,
  kind = 'issue',
}: {
  id: string
  kind?: 'issue' | 'item' | 'thread'
}) {
  const context = useContext(IssueContext)
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  if (!context) return null
  const { board, manager, features } = context
  // 提交、差异之类要向设备读原文（reference/read，属于 Posts）：比应用旧的设备服务读不了
  const unreadable = (target: ManagerRelationTarget) =>
    !features.posts && !['issue', 'item', 'thread', 'url', 'file'].includes(target.kind)
  const groups = managerRelationGroups(board, { kind, target: id })
  if (!Object.values(groups).some((g) => g.length)) return null
  const title = (target: ManagerRelationTarget) => {
    if (target.kind === 'thread')
      return (
        board.lines.find((l) => l.threadId === target.target)?.title ??
        target.label ??
        t('manager.source.line')
      )
    return (
      board.posts?.find((p) => p.id === target.target)?.title ??
      board.items.find((i) => i.id === target.target)?.title ??
      target.label ??
      (target.kind === 'issue' ? t('manager.issue') : target.target)
    )
  }
  const open = async (target: ManagerRelationTarget) => {
    setError('')
    try {
      if (target.kind === 'issue' || target.kind === 'item') {
        if (
          !features.paging &&
          !board.posts?.some((p) => p.id === target.target) &&
          !board.items.some((i) => i.id === target.target)
        )
          throw new Error(t('manager.linkUnavailable'))
        return context.open(target.target)
      }
      if (target.kind === 'thread')
        return navigation.navigate('Detail', {
          deviceId: manager.deviceId,
          sessionId: target.target,
          title: title(target),
        })
      if (target.kind === 'file') {
        const ref = knownFileRef(target.target, { root: manager.cwd, cwd: manager.cwd })
        if (!ref) throw new Error(t('manager.linkUnavailable'))
        return navigation.navigate('Files', {
          deviceId: manager.deviceId,
          root: manager.cwd,
          path: ref.path,
          ref,
          href: target.target,
        })
      }
      if (target.kind === 'url') {
        if (!/^https?:\/\//i.test(target.target)) throw new Error(t('manager.linkUnavailable'))
        await Linking.openURL(target.target)
        return
      }
      setPreview(
        (
          await channel.command('managers.reference.read', {
            deviceId: manager.deviceId,
            managerId: manager.id,
            reference: target.target,
          })
        ).text,
      )
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        testID={`relations:${id}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ alignSelf: 'flex-start', paddingVertical: 8 }}
      >
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
          {expanded ? '▾' : '▸'}{' '}
          {t(kind === 'issue' ? 'manager.relations' : 'manager.relatedIssues')}{' '}
          {Object.values(groups).flat().length}
        </Text>
      </Pressable>
      {expanded
        ? (Object.entries(groups) as [keyof typeof groups, ManagerRelationTarget[]][]).map(
            ([group, targets]) =>
              targets.length ? (
                <View key={group}>
                  <Text style={{ color: c.ink3 }}>{t(`manager.relation.${group}`)}</Text>
                  {targets.map((target) => (
                    <Pressable
                      key={`${target.kind}:${target.target}`}
                      testID={`relation:${target.target}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: unreadable(target) }}
                      disabled={unreadable(target)}
                      accessibilityHint={target.target}
                      onLongPress={() => Alert.alert(title(target), target.target)}
                      onPress={() => void open(target)}
                      style={{ paddingVertical: 8, gap: 3 }}
                    >
                      <Text style={{ color: c.ink3, fontSize: font.size.small }}>
                        {ICONS[target.kind]} {t(`manager.relationKind.${target.kind}`)}
                      </Text>
                      <Text
                        style={{
                          color: c.accent,
                          fontSize: font.size.meta,
                          textDecorationLine: 'underline',
                        }}
                      >
                        {target.kind === 'issue' || target.kind === 'item'
                          ? `#${target.target} · `
                          : ''}
                        {title(target)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null,
          )
        : null}
      {preview ? (
        <>
          <Button kind="plain" label={t('manager.close')} onPress={() => setPreview('')} />
          <Text selectable style={{ color: c.ink, fontFamily: font.mono }}>
            {preview}
          </Text>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}
