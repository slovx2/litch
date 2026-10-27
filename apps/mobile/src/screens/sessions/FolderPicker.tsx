// 加工作区时浏览设备上的目录（folders.list，和桌面端的 FolderPicker 同一条命令）：一层层点进去，
// 走到哪一层就把哪一层填进目录那一栏；隐藏的目录（以点开头）不列，要的话自己在栏里填。
import type { FolderListing } from '@litch/core'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; listing: FolderListing }
  | { kind: 'failed'; reason: string }

const childOf = (path: string, name: string): string =>
  path.endsWith('/') ? `${path}${name}` : `${path}/${name}`

export function FolderPicker({
  deviceId,
  start,
  onPick,
  onClose,
}: {
  deviceId: string
  /** 从哪一层开始；null 是设备的主目录 */
  start: string | null
  onPick(path: string): void
  onClose(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const channel = useChannel()
  const [target, setTarget] = useState<string | null>(start)
  const [state, setState] = useState<State>({ kind: 'loading' })

  // biome-ignore lint/correctness/useExhaustiveDependencies: onPick 每次渲染都是新的，只在换层时去问
  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    channel.command('folders.list', { deviceId, path: target }).then(
      (listing) => {
        if (!live) return
        setState({ kind: 'ready', listing })
        onPick(listing.path)
      },
      (error: unknown) => live && setState({ kind: 'failed', reason: reasonOf(error, t) }),
    )
    return () => {
      live = false
    }
  }, [channel, deviceId, target, t])

  const listing = state.kind === 'ready' ? state.listing : null
  const folders = listing?.folders.filter((name) => !name.startsWith('.')) ?? []
  const note = (text: string, color: string) => <Text style={[styles.note, { color }]}>{text}</Text>

  return (
    <View
      testID="workspace:picker"
      style={[styles.box, { borderColor: c.line1, borderRadius: theme.radius.m }]}
    >
      <View style={styles.head}>
        <Button
          kind="plain"
          label={t('workspace.browse.up')}
          disabled={!listing?.parent}
          onPress={() => listing?.parent && setTarget(listing.parent)}
        />
        <Text
          numberOfLines={1}
          ellipsizeMode="head"
          style={[styles.path, { color: c.ink2, fontFamily: theme.font.mono }]}
        >
          {listing?.path ?? target ?? '~'}
        </Text>
        <Button kind="plain" label={t('workspace.browse.done')} onPress={onClose} />
      </View>
      {state.kind === 'loading' ? (
        note(t('workspace.browse.loading'), c.ink3)
      ) : state.kind === 'failed' ? (
        <View style={styles.failed}>
          {note(t('workspace.browse.failed', { reason: state.reason }), c.err)}
          {target !== null ? (
            <Button
              kind="plain"
              label={t('workspace.browse.home')}
              onPress={() => setTarget(null)}
            />
          ) : null}
        </View>
      ) : folders.length === 0 ? (
        note(t('workspace.browse.empty'), c.ink3)
      ) : (
        folders.map((name) => (
          <Pressable
            key={name}
            accessibilityRole="button"
            testID={`workspace:picker:${name}`}
            onPress={() => listing && setTarget(childOf(listing.path, name))}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? c.press : 'transparent', borderRadius: theme.radius.s },
            ]}
          >
            <Text numberOfLines={1} style={{ color: c.ink, fontFamily: theme.font.mono }}>
              {name}/
            </Text>
          </Pressable>
        ))
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, padding: 6, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  path: { flex: 1, fontSize: 12 },
  note: { fontSize: 13, paddingHorizontal: 8, paddingVertical: 6 },
  failed: { gap: 4 },
  row: { paddingHorizontal: 8, paddingVertical: 9 },
})
