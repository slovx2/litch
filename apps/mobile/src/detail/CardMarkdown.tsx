// 卡片里的正文（子会话的回报、经理事件、别的会话发来的话）：同回答一样按 Markdown 画，
// 路径和网址照回答改写成链接，点了交给对话区（文件页、浏览器）；字号跟卡片的小字（cardMarkdownStyleOf）。
// 不在对话区里的（输入框上方排着的回报）没有对话区：只认网址
import { useContext, useMemo } from 'react'
import { Linking } from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import { useTheme } from '../ui/theme'
import { TranscriptContext } from './context'
import { isWebUrl, linkify } from './links'
import { cardMarkdownStyleOf } from './markdownStyle'

export function CardMarkdown({ text }: { text: string }) {
  const theme = useTheme()
  const transcript = useContext(TranscriptContext)
  const scope = transcript?.scope ?? null
  const markdown = useMemo(() => linkify(text, scope), [text, scope])
  return (
    <EnrichedMarkdownText
      markdown={markdown}
      flavor="github"
      markdownStyle={cardMarkdownStyleOf(theme)}
      onLinkPress={({ url }) => {
        if (transcript) transcript.openLink(url)
        else if (isWebUrl(url)) void Linking.openURL(url)
      }}
    />
  )
}
