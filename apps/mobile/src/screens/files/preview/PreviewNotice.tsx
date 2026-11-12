import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { useT } from '../../../ui/i18n'
import { Button, Empty } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { SavePhoneFile } from './SavePhoneFile'

/** compact：工具条里只放图标（读屏名称照旧）；空状态里仍是文字按钮 */
export function CopyPath({ path, compact = false }: { path: string; compact?: boolean }) {
  const t = useT()
  const { c } = useTheme()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const label = t(copied ? 'code.copied' : 'mobilePreview.copy')
  const press = () => {
    setFailed(false)
    void Clipboard.setStringAsync(path).then(
      () => setCopied(true),
      () => setFailed(true),
    )
  }
  return (
    <View style={compact ? { flexDirection: 'row', alignItems: 'center' } : undefined}>
      {failed ? <Text style={{ color: c.err }}>{t('mobilePreview.copyFailed')}</Text> : null}
      {compact ? (
        <IconButton
          icon={copied ? 'check' : 'copy'}
          label={label}
          testID="files:copy-path"
          onPress={press}
        />
      ) : (
        <Button kind="plain" testID="files:copy-path" label={label} onPress={press} />
      )}
    </View>
  )
}

export function PreviewNotice({
  deviceId,
  root,
  path,
  detail,
  retry,
}: {
  deviceId?: string
  root?: string
  path: string
  detail: string
  retry?: () => void
}) {
  const t = useT()
  return (
    <Empty
      title={t('files.view.failed')}
      detail={detail}
      action={
        <View style={{ gap: 8 }}>
          {retry ? (
            <Button
              kind="plain"
              testID="files:preview-retry"
              label={t('files.retry')}
              onPress={retry}
            />
          ) : null}
          <CopyPath path={path} />
          {deviceId && root ? <SavePhoneFile deviceId={deviceId} root={root} path={path} /> : null}
        </View>
      }
    />
  )
}
