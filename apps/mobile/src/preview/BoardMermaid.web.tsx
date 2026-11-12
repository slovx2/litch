// 看板正式 Markdown + 对话共用画图宿主，不需要真实账号或设备。
import { ScrollView, Text } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MermaidHost } from '../detail/mermaid/MermaidHost'
import { Markdown } from '../screens/managers/IssueMarkdown'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, ThemeContext } from '../ui/theme'

export function BoardMermaidPreview() {
  const theme = makeTheme('standard', true)
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator('zh-CN')}>
        <ThemeContext.Provider value={theme}>
          <ScrollView
            style={{ flex: 1, backgroundColor: theme.c.win }}
            contentContainerStyle={{ padding: 16, gap: 12 }}
          >
            <Text style={{ color: theme.c.ink, fontSize: 18 }}>星云报告 · Mermaid</Text>
            <Markdown
              text={
                '报告中的流程图。\n\n```mermaid\nflowchart LR\n A[星云报告] --> B[核对证据]\n B --> C[完成]\n```'
              }
            />
            <Text style={{ color: theme.c.ink }}>无效图表回退源码</Text>
            <Markdown text={'```mermaid\nnot a valid diagram\n```'} />
          </ScrollView>
          <MermaidHost />
        </ThemeContext.Provider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
