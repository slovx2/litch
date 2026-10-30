// 验收专用：直接走正式手机 Markdown 组件的网页入口，和两端单测共用语料。
import { ScrollView, Text, View } from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import cases from '../../../../packages/ui/test/fixtures/cjk-emphasis.json'
import { linkify } from '../detail/links'
import { markdownStyleOf } from '../detail/markdownStyle'
import { makeTheme } from '../ui/theme'

export function CjkEmphasisPreview() {
  const theme = makeTheme('standard', false)
  return (
    <ScrollView style={{ backgroundColor: theme.c.win }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: theme.c.ink, fontSize: 20 }}>手机 · Markdown 定界符</Text>
      {cases.slice(0, 17).map(({ source }) => (
        <View key={source} style={{ paddingVertical: 6 }}>
          <Text style={{ color: theme.c.ink, fontFamily: theme.font.mono, fontSize: 11 }}>
            {source}
          </Text>
          <EnrichedMarkdownText
            markdown={linkify(source, null)}
            flavor="github"
            selectable
            markdownStyle={markdownStyleOf(theme)}
          />
        </View>
      ))}
    </ScrollView>
  )
}
