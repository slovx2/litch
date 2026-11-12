import { managerRequestStatus } from '@litch/core'
// 议题正文：沿用对话 Markdown，#D-n 等编号点按跳转、长按看标题与状态。
import { useContext, useMemo, useState } from 'react'
import { Alert, Linking, View } from 'react-native'
import { MermaidCard } from '../../detail/mermaid/MermaidCard'
import { type MermaidShown, MermaidViewer } from '../../detail/mermaid/MermaidViewer'
import { splitMermaid } from '../../detail/mermaid/segments'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { WebLinkMarkdown as EnrichedMarkdownText } from '../../ui/WebLinkMenu'
import { IssueContext } from './IssueRelations'
import { issueMarkdownStyle, situationMarkdownStyle } from './presentation'
import { issueLinks } from './relations'

/** situation：概览现状用的排版（小标题更醒目、行距更宽） */
export function Markdown({ text, situation }: { text: string; situation?: boolean }) {
  const theme = useTheme()
  const t = useT()
  const context = useContext(IssueContext)
  const segments = useMemo(() => splitMermaid(text), [text])
  const [shown, setShown] = useState<MermaidShown | null>(null)
  const ids = new Set([
    ...(context?.board.posts ?? []).map((p) => p.id),
    ...(context?.board.items ?? []).map((i) => i.id),
  ])
  const prose = (text: string, key: number) => (
    <EnrichedMarkdownText
      key={key}
      markdown={issueLinks(text, ids, context?.features.paging)}
      flavor="github"
      markdownStyle={situation ? situationMarkdownStyle(theme) : issueMarkdownStyle(theme)}
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
            ? t(`manager.request.${managerRequestStatus(request)}`)
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
  return (
    <View>
      {segments.map((segment) =>
        segment.kind === 'md' ? (
          prose(segment.text, segment.at)
        ) : (
          <MermaidCard
            key={segment.at}
            source={segment.source}
            onOpen={(source, svg) => setShown({ source, svg })}
          />
        ),
      )}
      {shown ? <MermaidViewer shown={shown} onClose={() => setShown(null)} /> : null}
    </View>
  )
}
