import type { ExternalMissingResultReply } from '@litch/core'
import { Pressable, Text } from 'react-native'
import { useT } from '../../../ui/i18n'
import { useTheme } from '../../../ui/theme'
import { openGithub } from './labels'

export function MissingResultReply({ reply }: { reply: ExternalMissingResultReply }) {
  const t = useT()
  const { c, font } = useTheme()
  return (
    <Pressable
      accessibilityRole="link"
      testID={`missing-result-reply:${reply.issueId}`}
      onPress={() => openGithub(reply.subject.url)}
    >
      <Text style={{ color: c.wait, fontSize: font.size.meta }}>
        {reply.issueId} · {t('mgh.missingResultReply')} ↗
      </Text>
    </Pressable>
  )
}
