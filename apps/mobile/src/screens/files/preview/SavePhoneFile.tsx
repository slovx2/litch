import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { reasonOf } from '../../../../../../packages/ui/src/app/errors.ts'
import { byteSize } from '../../../../../../packages/ui/src/files/lines.ts'
import { type ExportProgress, savePhoneFile } from '../../../platform/file-export'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { IconButton } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'

export function SavePhoneFile({
  deviceId,
  root,
  path,
}: {
  deviceId: string
  root: string
  path: string
}) {
  const channel = useChannel(),
    t = useT(),
    theme = useTheme()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState<ExportProgress | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const save = async () => {
    const abort = new AbortController()
    request.current = abort
    setBusy(true)
    setError('')
    setProgress(null)
    try {
      await savePhoneFile(channel, { deviceId, root, path }, abort.signal, setProgress)
    } catch (error) {
      if (abort.signal.aborted) return
      const code = error instanceof Error ? error.message : ''
      setError(
        code === 'exportUnavailable' || code === 'exportDiskFull'
          ? t(`mobilePreview.${code}`)
          : reasonOf(error, t),
      )
    } finally {
      if (request.current === abort) {
        setBusy(false)
        request.current = null
      }
    }
  }
  return (
    // 进度和失败原因写在图标左侧同一行，放进工具条时不撑高
    <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 4, flexShrink: 1 }}>
      <IconButton
        icon={busy ? 'stop' : 'download'}
        testID="files:save"
        label={t(busy ? 'mobilePreview.cancelSave' : 'mobilePreview.save')}
        onPress={() => (busy ? request.current?.abort() : void save())}
      />
      {busy && progress ? (
        <Text style={{ color: theme.c.ink3, fontSize: theme.font.size.meta }}>
          {t('mobilePreview.saving', {
            size: byteSize(progress.bytes),
            total: byteSize(progress.total),
          })}
        </Text>
      ) : null}
      {error ? (
        <Text
          accessibilityRole="alert"
          numberOfLines={2}
          style={{ flexShrink: 1, color: theme.c.err, fontSize: theme.font.size.meta }}
        >
          {t('mobilePreview.saveFailed', { reason: error })}
        </Text>
      ) : null}
    </View>
  )
}
