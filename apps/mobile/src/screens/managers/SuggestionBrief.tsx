// 看板建议卡展开后的简报：背景、任务两段直接摊开（收起时卡上已有背景首句，不再重复），
// 长的先露一截，按“展开全文”看全。和桌面端看板建议卡（packages/ui/src/tree/BriefSections.tsx）一致。
import { type ComponentType, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

/** 折起时露出的高度（约八行正文） */
const FOLDED = 160

function FoldSection({
  label,
  text,
  testID,
  Markdown,
}: {
  label: string
  text: string
  testID: string
  Markdown: ComponentType<{ text: string }>
}) {
  const t = useT()
  const { c, font, hit } = useTheme()
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const long = height > FOLDED + 8
  return (
    <View style={{ gap: 2 }} testID={testID}>
      <Text style={{ color: c.ink3, fontSize: font.size.small, fontWeight: '600' }}>{label}</Text>
      <View style={!open && long ? { maxHeight: FOLDED, overflow: 'hidden' } : null}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <Markdown text={text} />
        </View>
      </View>
      {long ? (
        <Pressable
          style={{ minHeight: hit, justifyContent: 'center', alignSelf: 'flex-start' }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          testID={`${testID}:fold`}
        >
          <Text style={{ color: c.accent, fontSize: font.size.meta }}>
            {t(open ? 'proposal.brief.fold' : 'proposal.brief.unfold')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export function SuggestionBrief({
  prompt,
  background = '',
  testID,
  renderText,
}: {
  prompt: string
  background?: string | undefined
  testID: string
  renderText: ComponentType<{ text: string }>
}) {
  const t = useT()
  return (
    <>
      {background.trim() ? (
        <FoldSection
          label={t('proposal.brief.background')}
          text={background.trim()}
          testID={`${testID}:background`}
          Markdown={renderText}
        />
      ) : null}
      {prompt.trim() ? (
        <FoldSection
          label={t('proposal.brief.task')}
          text={prompt}
          testID={`${testID}:task`}
          Markdown={renderText}
        />
      ) : null}
    </>
  )
}
