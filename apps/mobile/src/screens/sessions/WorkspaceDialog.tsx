// 加工作区、改工作区的名字和颜色。加的时候填目录（设备上的完整路径），也可以从“还没归进工作区的会话用过的目录”里挑；
// 目录定了就不改（照桌面端，要换目录另加一个）。名字不填就用目录的最后一段。
import type { WireColor, WorkspaceView } from '@litch/core'
import { useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import { useBusy, useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

const COLORS: WireColor[] = ['blue', 'orange', 'green', 'brown', 'slate', 'red', 'yellow', 'violet']

const baseOf = (path: string): string => {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

export type WorkspaceEdit = { kind: 'add' } | { kind: 'edit'; workspace: WorkspaceView }

export function WorkspaceDialog({
  deviceId,
  edit,
  onClose,
}: {
  deviceId: string
  /** null：不显示 */
  edit: WorkspaceEdit | null
  onClose(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const channel = useChannel()
  const [busy, run] = useBusy()
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  const [color, setColor] = useState<WireColor | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const adding = edit?.kind === 'add'

  useEffect(() => {
    setFailure(null)
    if (!edit) return
    if (edit.kind === 'edit') {
      setName(edit.workspace.name)
      setRoot(edit.workspace.roots[0] ?? '')
      setColor(edit.workspace.color)
      return
    }
    setName('')
    setRoot('')
    setColor(null)
    setCandidates([])
    let live = true
    channel.command('workspace.candidates', { deviceId }).then(
      ({ roots }) => live && setCandidates(roots),
      () => {},
    )
    return () => {
      live = false
    }
  }, [edit, channel, deviceId])

  const submit = () => {
    if (!edit) return
    setFailure(null)
    const work: Promise<unknown> =
      edit.kind === 'add'
        ? channel.command('workspace.create', {
            deviceId,
            name: name.trim() || baseOf(root),
            root: root.trim(),
            color,
          })
        : channel.command('workspace.update', {
            deviceId,
            workspaceId: edit.workspace.id,
            name: name.trim() || edit.workspace.name,
            color,
          })
    run(work).then(onClose, (error: unknown) =>
      setFailure(t('session.failed', { reason: reasonOf(error, t) })),
    )
  }

  const swatch = (value: WireColor | null) => {
    const on = color === value
    return (
      <Pressable
        key={value ?? 'none'}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        accessibilityLabel={value ?? t('workspace.color.none')}
        testID={`workspace:color:${value ?? 'none'}`}
        onPress={() => setColor(value)}
        style={[
          styles.swatch,
          {
            borderColor: on ? c.line3 : c.line1,
            borderWidth: on ? 2 : 1,
            backgroundColor: value ? c.wire[value] : c.raised,
          },
        ]}
      >
        {value ? null : <Text style={{ color: c.ink3 }}>∅</Text>}
      </Pressable>
    )
  }

  return (
    <Modal visible={edit !== null} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.center}
      >
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={[styles.dialog, { backgroundColor: c.raised, borderColor: c.line3 }]}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            <Text style={[styles.title, { color: c.ink }]}>
              {t(adding ? 'workspace.add.title' : 'workspace.edit.title')}
            </Text>
            {adding ? (
              <>
                <Field
                  label={t('workspace.root')}
                  hint={t('workspace.root.hint')}
                  value={root}
                  onChangeText={setRoot}
                  placeholder="/home/me/project"
                  testID="workspace:root"
                  style={{ fontFamily: theme.font.mono }}
                />
                {candidates.length > 0 ? (
                  <View style={styles.candidates}>
                    <Text style={[styles.label, { color: c.ink2 }]}>
                      {t('workspace.root.candidates')}
                    </Text>
                    {candidates.slice(0, 6).map((path) => (
                      <Pressable
                        key={path}
                        accessibilityRole="button"
                        onPress={() => setRoot(path)}
                        style={({ pressed }) => [
                          styles.candidate,
                          { borderColor: c.line1, backgroundColor: pressed ? c.press : c.panel },
                        ]}
                      >
                        <Text
                          numberOfLines={1}
                          style={{ color: c.ink, fontFamily: theme.font.mono, fontSize: 12 }}
                        >
                          {path}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </>
            ) : (
              <Text style={[styles.label, { color: c.ink3 }]}>{t('workspace.root.fixed')}</Text>
            )}
            <Field
              label={t('workspace.name')}
              hint={t('workspace.name.hint')}
              value={name}
              onChangeText={setName}
              placeholder={adding ? baseOf(root) : undefined}
              testID="workspace:name"
            />
            <Text style={[styles.label, { color: c.ink2 }]}>{t('workspace.color')}</Text>
            <View style={styles.swatches}>{[null, ...COLORS].map(swatch)}</View>
            {failure ? <Text style={{ color: c.err }}>{failure}</Text> : null}
            <View style={styles.buttons}>
              <Button kind="plain" label={t('workspace.cancel')} onPress={onClose} />
              <Button
                label={t(adding ? 'workspace.create' : 'workspace.save')}
                testID="workspace:ok"
                busy={busy}
                disabled={adding && !root.trim()}
                onPress={submit}
              />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: 20 },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  dialog: { borderWidth: 1, maxHeight: '90%' },
  body: { padding: 20, gap: 14 },
  title: { fontSize: 17, fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '500' },
  candidates: { gap: 6 },
  candidate: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
