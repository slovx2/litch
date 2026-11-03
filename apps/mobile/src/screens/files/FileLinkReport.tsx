import type { FileLinkResolution, FileLinkTarget } from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

export function FileLinkReport({
  result,
  onPick,
  expanded = false,
}: {
  result: FileLinkResolution
  onPick?(target: FileLinkTarget): void
  expanded?: boolean
}) {
  const t = useT()
  const theme = useTheme()
  const [open, setOpen] = useState(expanded)
  const [copyState, setCopyState] = useState('')
  const textStyle = {
    color: theme.c.ink,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.meta,
  }
  const path = result.path || result.href
  return (
    <View style={{ padding: theme.space(3), gap: theme.space(2) }}>
      {onPick ? (
        <Text style={textStyle}>
          {t(result.status === 'choose' ? 'files.link.choose' : 'files.link.failed')}
        </Text>
      ) : null}
      {onPick
        ? result.candidates.map((candidate) => (
            <Button
              key={candidate.path}
              kind="plain"
              label={candidate.path}
              onPress={() => onPick(candidate)}
            />
          ))
        : null}
      {onPick
        ? result.failures.map((failure) => (
            <Text key={failure.path} style={textStyle}>
              {t(`files.link.error.${failure.reason}`)}
              {'\n'}
              {failure.path}
            </Text>
          ))
        : null}
      <Button
        kind="plain"
        label={t('files.link.details')}
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <>
          <Text selectable style={textStyle}>
            {t('files.link.href')}
            {'\n'}
            {result.href}
          </Text>
          <Text selectable style={textStyle}>
            {t('files.link.path')}
            {'\n'}
            {result.path || t('files.link.notResolved')}
          </Text>
          <Text selectable style={textStyle}>
            {t('files.link.attempted')}
            {'\n'}
            {result.attempted.join('\n') || t('files.link.notAttempted')}
          </Text>
          <Button
            kind="plain"
            label={t('files.action.copyFull')}
            onPress={() => {
              void Clipboard.setStringAsync(path).then(
                (copied) => setCopyState(t(copied ? 'message.copied' : 'message.copy.failed')),
                () => setCopyState(t('message.copy.failed')),
              )
            }}
          />
          {copyState ? (
            <Text accessibilityRole="alert" style={textStyle}>
              {copyState}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  )
}
