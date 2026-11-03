// 议题正文：沿用对话 Markdown，#D-n 等编号点按跳转、长按看标题与状态。
import { useContext } from 'react'
import { Alert, Linking } from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { IssueContext } from './IssueRelations'
import { issueMarkdownStyle } from './presentation'
import { issueLinks } from './relations'

export function Markdown({ text }: { text: string }) {
  const theme = useTheme()
  const t = useT()
  const context = useContext(IssueContext)
  const ids = new Set([
    ...(context?.board.posts ?? []).map((p) => p.id),
    ...(context?.board.items ?? []).map((i) => i.id),
  ])
  return (
    <EnrichedMarkdownText
      markdown={issueLinks(text, ids, context?.features.paging)}
      flavor="github"
      markdownStyle={issueMarkdownStyle(theme)}
      onLinkLongPress={({ url }) => {
        if (!url.startsWith('litch-issue:')) return
        const id = url.slice('litch-issue:'.length)
        const item = context?.board.items.find((i) => i.id === id)
        const post = context?.board.posts?.find((p) => p.id === id)
        const decision = context?.board.decisions.find((d) => d.id === id)
        const request = context?.board.requests?.find((r) => r.id === id)
        const status = item
          ? t(`manager.status.${item.status}`)
          : request
            ? t(`manager.request.${request.status}`)
            : decision
              ? t(
                  decision.status === 'open'
                    ? 'manager.open'
                    : decision.status === 'answered'
                      ? 'manager.answered'
                      : 'manager.closed',
                )
              : post?.kind === 'report'
                ? t(post.unread ? 'manager.reportUnread' : 'manager.reportRead')
                : ''
        Alert.alert(`${id} · ${post?.title ?? item?.title ?? ''}`, status)
      }}
      onLinkPress={({ url }) => {
        if (url.startsWith('litch-issue:')) context?.open(url.slice('litch-issue:'.length))
        else if (/^https?:\/\//.test(url)) void Linking.openURL(url)
      }}
    />
  )
}
