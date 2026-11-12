import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { useT } from '../../../ui/i18n'
import { Button, Empty } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { SavePhoneFile } from './SavePhoneFile'

export function CopyPath({ path }: { path: string }) {
  const t = useT()
  const { c } = useTheme()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <View>
      <Button
        kind="plain"
        testID="files:copy-path"
        label={t(copied ? 'code.copied' : 'mobilePreview.copy')}
        onPress={() => {
          setFailed(false)
          void Clipboard.setStringAsync(path).then(
            () => setCopied(true),
            () => setFailed(true),
          )
        }}
      />
      {failed ? <Text style={{ color: c.err }}>{t('mobilePreview.copyFailed')}</Text> : null}
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
