// 手机上的选择器浏览连接的设备，绝不使用手机文件系统代替服务器目录。
import {
  type PathPickerKind,
  type PathPickerListing,
  pathPickerChild,
  pathPickerDirectory,
  pathPickerStart,
  readPathPicker,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { reasonOf } from '../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../shell/services'
import { useT } from './i18n'
import { Button, Field, Loading } from './kit/controls'
import { IconButton } from './kit/Icon'
import { Dialog } from './kit/overlays'
import { useTheme } from './theme'

export function PathPicker({
  deviceId,
  value,
  kind,
  bounded = false,
  compact = false,
  disabled = false,
  onPick,
}: {
  deviceId: string
  value: string
  bounded?: boolean
  compact?: boolean
  kind?: PathPickerKind | undefined
  disabled?: boolean
  onPick(path: string): void
}) {
  const t = useT()
  const [mode, setMode] = useState<PathPickerKind | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换设备时关闭旧设备的路径选择草稿。
  useEffect(() => setMode(null), [deviceId])
  return (
    <>
      <View style={styles.actions}>
        {(kind ? [kind] : (['directory', 'file'] as const)).map((selected) =>
          compact ? (
            <IconButton
              key={selected}
              icon="folder"
              label={t('files.nav.open')}
              disabled={disabled}
              testID={`path-picker:${selected}`}
              onPress={() => setMode(selected)}
            />
          ) : (
            <Button
              key={selected}
              kind="plain"
              disabled={disabled}
              label={t(
                bounded
                  ? 'files.nav.open'
                  : selected === 'directory'
                    ? 'pathPicker.directory'
                    : 'pathPicker.file',
              )}
              testID={`path-picker:${selected}`}
              onPress={() => setMode(selected)}
            />
          ),
        )}
      </View>
      {mode ? (
        <Browser
          key={`${deviceId}:${mode}`}
          deviceId={deviceId}
          kind={mode}
          bounded={bounded}
          start={pathPickerStart(value, mode)}
          onPick={(path) => {
            onPick(path)
            setMode(null)
          }}
          onClose={() => setMode(null)}
        />
      ) : null}
    </>
  )
}

function Browser({
  deviceId,
  kind,
  bounded,
  start,
  onPick,
  onClose,
}: {
  deviceId: string
  kind: PathPickerKind
  bounded: boolean
  start: string | null
  onPick(path: string): void
  onClose(): void
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const [target, setTarget] = useState({ path: start })
  const [input, setInput] = useState(start ?? '~')
  const [listing, setListing] = useState<PathPickerListing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    const abort = new AbortController()
    setBusy(true)
    setError('')
    setListing(null)
    readPathPicker(channel, deviceId, kind, target.path, abort.signal, bounded)
      .then(
        (next) => {
          if (!abort.signal.aborted) {
            setListing(next)
            setInput(next.path)
          }
        },
        (cause) => {
          if (!abort.signal.aborted) setError(reasonOf(cause, t))
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [channel, deviceId, kind, target, t, bounded])
  return (
    <Dialog visible onClose={onClose}>
      <Text
        testID={listing ? `path-picker:listing:${listing.path}` : undefined}
        style={{ color: theme.c.ink }}
      >
        {t(kind === 'directory' ? 'pathPicker.directory' : 'pathPicker.file')}
      </Text>
      <Field
        label={t('pathPicker.path')}
        value={input}
        onChangeText={setInput}
        testID="path-picker:path"
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => setTarget({ path: input.trim() || null })}
      />
      <View style={styles.actions}>
        <Button
          kind="plain"
          label={t('pathPicker.go')}
          onPress={() => setTarget({ path: input.trim() || null })}
        />
        <Button
          kind="plain"
          label={t('workspace.browse.up')}
          disabled={busy || !listing?.parent}
          onPress={() => setTarget({ path: listing?.parent ?? null })}
        />
        <Button
          kind="plain"
          label={t('workspace.browse.home')}
          onPress={() => setTarget({ path: null })}
        />
      </View>
      {busy ? (
        <Loading text={t('workspace.browse.loading')} />
      ) : error ? (
        <Text accessibilityRole="alert" style={{ color: theme.c.err }}>
          {error}
        </Text>
      ) : (
        listing?.entries.map((entry) => (
          <Button
            key={entry.name}
            kind="plain"
            label={`${entry.name}${pathPickerDirectory(entry) ? '/' : ''}${entry.kind === 'link' ? ` · ${t('pathPicker.link')}` : ''}${entry.executable ? ` · ${t('pathPicker.executable')}` : ''}`}
            testID={`path-picker:entry:${entry.name}`}
            onPress={() => {
              if (!listing) return
              const path = pathPickerChild(listing.path, entry.name)
              if (pathPickerDirectory(entry)) setTarget({ path })
              else onPick(path)
            }}
          />
        ))
      )}
      {!busy && !error && listing?.entries.length === 0 ? (
        <Text style={{ color: theme.c.ink3 }}>{t('pathPicker.empty')}</Text>
      ) : null}
      {listing?.truncated ? (
        <Text style={{ color: theme.c.ink3 }}>{t('pathPicker.truncated')}</Text>
      ) : null}
      <View style={styles.actions}>
        <Button kind="plain" label={t('app.cancel')} onPress={onClose} />
        {kind === 'directory' ? (
          <Button
            label={t('pathPicker.selectDirectory')}
            disabled={busy || !listing}
            testID="path-picker:select"
            onPress={() => listing && onPick(listing.path)}
          />
        ) : null}
      </View>
    </Dialog>
  )
}
const styles = StyleSheet.create({ actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } })
