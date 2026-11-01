import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { createContext, useContext, useState } from 'react'
import { Linking, Text, View } from 'react-native'
import type {
  ManagerBoardView,
  ManagerView,
} from '../../../../../packages/core/src/model-manager.mts'
import type { ManagerRelationTarget } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { relationGroups } from '../../../../../packages/protocol/src/manager-relations.mts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
export const IssueContext = createContext<{
  board: ManagerBoardView
  manager: ManagerView
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
  const { board, manager } = context
  const groups = relationGroups(board.relations ?? [], { kind, target: id })
  if (!Object.values(groups).some((g) => g.length)) return null
  const title = (target: ManagerRelationTarget) =>
    board.posts?.find((p) => p.id === target.target)?.title ??
    board.items.find((i) => i.id === target.target)?.title ??
    board.lines.find((l) => l.threadId === target.target)?.title ??
    target.label ??
    target.target
  const open = async (target: ManagerRelationTarget) => {
    if (target.kind === 'issue' || target.kind === 'item') return context.open(target.target)
    if (target.kind === 'thread')
      return navigation.navigate('Detail', {
        deviceId: manager.deviceId,
        sessionId: target.target,
        title: title(target),
      })
    if (target.kind === 'file')
      return navigation.navigate('Files', {
        deviceId: manager.deviceId,
        root: manager.cwd,
        path: /^(\/|[A-Za-z]:[\\/])/.test(target.target)
          ? target.target
          : `${manager.cwd}/${target.target}`,
      })
    if (target.kind === 'url') {
      if (/^https?:\/\//.test(target.target)) await Linking.openURL(target.target)
      return
    }
    try {
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
      <Button
        kind="plain"
        label={t(kind === 'issue' ? 'manager.relations' : 'manager.relatedIssues')}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded
        ? (Object.entries(groups) as [keyof typeof groups, ManagerRelationTarget[]][]).map(
            ([group, targets]) =>
              targets.length ? (
                <View key={group}>
                  <Text style={{ color: c.ink3 }}>{t(`manager.relation.${group}`)}</Text>
                  {targets.map((target) => (
                    <Button
                      kind="plain"
                      key={`${target.kind}:${target.target}`}
                      label={`${target.target} · ${title(target)}`}
                      onPress={() => void open(target)}
                    />
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
      {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
    </View>
  )
}
