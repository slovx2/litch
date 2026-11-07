import { type ComponentType, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { proposalSummary } from '../../../../../packages/ui/src/tree/proposal-brief.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { CardMarkdown } from '../CardMarkdown'

/** 各建议入口共用：摘要始终可读，全文只在明确展开后挂载，操作按钮不随简报折叠。 */
export function ProposalBrief({
  prompt,
  background = '',
  testID,
  renderText: Markdown = CardMarkdown,
}: {
  prompt: string
  background?: string
  testID: string
  renderText?: ComponentType<{ text: string }>
}) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const { c, font, hit } = useTheme()
  if (!prompt && !background.trim()) return null
  const style = { color: c.ink2, fontSize: font.size.meta, lineHeight: 19 }
  return (
    <View style={{ gap: 6 }}>
      <Text style={style} testID={`${testID}:summary`}>
        {proposalSummary(background, prompt)}
      </Text>
      <Pressable
        style={{ minHeight: hit, justifyContent: 'center' }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        testID={testID}
      >
        <Text style={{ color: c.accent, fontSize: font.size.meta }}>
          {t(open ? 'proposal.brief.less' : 'proposal.brief.more')}
        </Text>
      </Pressable>
      {open ? (
        <View testID={`${testID}:full`} style={{ gap: 6 }}>
          {background.trim() ? (
            <>
              <Text style={style}>{t('proposal.brief.background')}</Text>
              <Markdown text={background} />
            </>
          ) : null}
          <Text style={style}>{t('proposal.brief.task')}</Text>
          <Markdown text={prompt} />
        </View>
      ) : null}
    </View>
  )
}
