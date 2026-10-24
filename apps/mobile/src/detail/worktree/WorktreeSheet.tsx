// 详情页菜单里的“工作树”：会话在设备层建的工作树里时出来（桌面信息栏工作树卡片 RailWorktree.tsx 的手机版）。
// 写分支、起点、路径；能复制路径、打开开在工作树里的终端、把基础分支的新提交合进来（不推送）；
// 目录被删了的（改动留了快照）能建回来。
import type { SessionWorktreeView, WorktreeSyncView } from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { baseOf, canSync, syncNote } from './logic'

export function WorktreeSheet({
  visible,
  deviceId,
  worktree,
  onTerminal,
  onClose,
}: {
  visible: boolean
  deviceId: string
  worktree: SessionWorktreeView
  /** 打开开在工作树根上的终端 */
  onTerminal(): void
  onClose(): void
}) {
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const channel = useChannel()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [synced, setSynced] = useState<WorktreeSyncView | null>(null)
  const removed = worktree.state === 'removed'
  const base = baseOf(worktree, t)
  const act = (work: Promise<unknown>) => {
    setBusy(true)
    setFailure(null)
    setSynced(null)
    work.catch((reason: unknown) => setFailure(whyNot(reason, t))).finally(() => setBusy(false))
  }
  const restore = () => act(channel.command('worktree.restore', { deviceId, id: worktree.id }))
  const sync = () =>
    act(
      channel
        .command('worktree.syncBase', { deviceId, id: worktree.id })
        .then(({ result }) => setSynced(result)),
    )
  const copy = () => {
    void Clipboard.setStringAsync(worktree.path).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const facts: [string, string, string][] = [
    [t('worktree.branch'), worktree.branch, 'branch'],
    [t('worktree.base'), base, 'base'],
    [t('info.path'), worktree.path, 'path'],
  ]
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} testID="worktree:scrim" />
      <View
        testID="worktree:sheet"
        style={[
          styles.sheet,
          {
            backgroundColor: c.raised,
            borderColor: c.line3,
            borderTopLeftRadius: theme.radius.l,
            borderTopRightRadius: theme.radius.l,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <Text style={[styles.title, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {t('worktree.title')}
        </Text>
        {facts.map(([label, value, id]) => (
          <View key={id} style={styles.fact}>
            <Text style={[styles.label, { color: c.ink3 }]}>{label}</Text>
            <Text
              selectable
              testID={`worktree:${id}`}
              style={[styles.value, { color: c.ink, fontFamily: theme.font.mono }]}
            >
              {value}
            </Text>
          </View>
        ))}
        {removed ? (
          <Text style={[styles.note, { color: c.ink2 }]} testID="worktree:removed">
            {t('worktree.removedNote')}
          </Text>
        ) : null}
        {synced ? (
          <Text style={[styles.note, { color: c.ink2 }]} testID="worktree:synced">
            {syncNote(synced, base, t)}
          </Text>
        ) : null}
        {failure ? (
          <Text style={[styles.note, { color: c.err }]} testID="worktree:failure">
            {failure}
          </Text>
        ) : null}
        <View style={styles.acts}>
          {removed ? (
            <Button
              label={t(busy ? 'worktree.restoring' : 'worktree.restore')}
              busy={busy}
              testID="worktree:restore"
              onPress={restore}
            />
          ) : (
            <Button
              kind="plain"
              label={t('worktree.terminal')}
              testID="worktree:terminal"
              onPress={() => {
                onClose()
                onTerminal()
              }}
            />
          )}
          {canSync(worktree) ? (
            <Button
              kind="plain"
              label={t(busy ? 'worktree.syncing' : 'worktree.sync', { base })}
              busy={busy}
              testID="worktree:sync"
              onPress={sync}
            />
          ) : null}
          <Button
            kind="plain"
            label={t(copied ? 'worktree.copied' : 'worktree.copyPath')}
            testID="worktree:copy"
            onPress={copy}
          />
        </View>
        {canSync(worktree) ? (
          <Text style={[styles.hint, { color: c.ink3 }]}>{t('worktree.sync.hint')}</Text>
        ) : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopWidth: 1, maxHeight: '70%' },
  title: { fontSize: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  fact: { paddingHorizontal: 16, paddingVertical: 6, gap: 2 },
  label: { fontSize: 12 },
  value: { fontSize: 13 },
  note: { fontSize: 13, paddingHorizontal: 16, paddingTop: 8, lineHeight: 19 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  hint: { fontSize: 12, paddingHorizontal: 16, paddingTop: 6, lineHeight: 17 },
})
