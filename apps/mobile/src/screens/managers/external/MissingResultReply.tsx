import type { ExternalMissingResultReply } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../../ui/i18n'
import { Icon } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { openGithub } from './labels'

/** 一条未回原帖：编号加外链记号，点了去 GitHub 原帖 */
function ReplyLink({
  reply,
  withLabel,
}: {
  reply: ExternalMissingResultReply
  withLabel: boolean
}) {
  const t = useT()
  const { c, font } = useTheme()
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${reply.issueId} · ${t('mgh.missingResultReply')}`}
      hitSlop={{ top: 8, bottom: 8 }}
      testID={`missing-result-reply:${reply.issueId}`}
      onPress={() => openGithub(reply.subject.url)}
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: c.wait, fontSize: font.size.meta }}>
        {withLabel ? `${reply.issueId} · ${t('mgh.missingResultReply')}` : reply.issueId}
      </Text>
      <Icon name="external" size={11} color={c.wait} />
    </Pressable>
  )
}

export function MissingResultReply({ reply }: { reply: ExternalMissingResultReply }) {
  return <ReplyLink reply={reply} withLabel />
}

/** 同一来源的多条未回原帖并成一行：“未回原帖”只写一次，后面是各条编号 */
export function MissingResultReplies({ replies }: { replies: ExternalMissingResultReply[] }) {
  const t = useT()
  const { c, font } = useTheme()
  const [only] = replies
  if (!only) return null
  if (replies.length === 1) return <ReplyLink reply={only} withLabel />
  return (
    <View style={styles.row}>
      <Text style={{ color: c.wait, fontSize: font.size.meta }}>{t('mgh.missingResultReply')}</Text>
      {replies.map((reply) => (
        <ReplyLink key={`${reply.managerId}/${reply.issueId}`} reply={reply} withLabel={false} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  link: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
})
