// 网页预览里的 react-native-enriched-markdown（metro.config.js 只在打网页包时把它指到这里）：用它自带的网页版，
// 外面包一层 View 补上 onLayout。网页版不接 onLayout，而且是异步解析的（wasm），刚挂上时高度是 0；
// 对话区的回答单元格（src/detail/cells.tsx 的 freeze）靠第一次 onLayout 钉高度、顺带让列表重新量，
// 所以这里等内容出来、高度不为 0 才往上报
import type { ComponentType } from 'react'
import { type LayoutChangeEvent, View } from 'react-native'
import type { EnrichedMarkdownTextProps } from 'react-native-enriched-markdown'
// @ts-expect-error 包里没有给网页版这个文件单独的类型，属性和手机版的一样
import { EnrichedMarkdownText as WebMarkdown } from 'react-native-enriched-markdown/lib/module/index.web'

const Real = WebMarkdown as ComponentType<EnrichedMarkdownTextProps>

// 外面那层一直在：钉了高度之后 onLayout 没了，要是换成不包的样子，组件会整个重新挂载、重新解析，
// 中间高度塌回 0，列表又按 0 排
export function EnrichedMarkdownText({ onLayout, ...props }: EnrichedMarkdownTextProps) {
  return (
    <View
      onLayout={(event: LayoutChangeEvent) => {
        if (event.nativeEvent.layout.height > 0) onLayout?.(event)
      }}
    >
      <Real {...props} />
    </View>
  )
}

export default EnrichedMarkdownText
