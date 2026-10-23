// 网页预览里 react-native-webview 的替身（metro.config.js 只在打网页包时把它指到这里）：一个同源的 srcdoc iframe。
// 只做页面用到的那几样：source.html、injectedJavaScriptBeforeContentLoaded、onMessage、
// ref 上的 injectJavaScript 和 requestFocus；别的属性收下不管。
// 页面里照旧调 window.ReactNativeWebView.postMessage(字符串)，经 iframe 元素上挂的回调交回 onMessage。
import { Component } from 'react'
import { type StyleProp, View, type ViewStyle } from 'react-native'

export interface WebViewMessageEvent {
  nativeEvent: { data: string }
}

interface WebViewProps {
  source?: { html?: string; uri?: string }
  injectedJavaScriptBeforeContentLoaded?: string
  onMessage?(event: WebViewMessageEvent): void
  style?: StyleProp<ViewStyle>
  testID?: string
  [other: string]: unknown
}

type Frame = HTMLIFrameElement & { __litchMessage?: (data: string) => void }

/** 放在页面最前面的桥：先于页面自己的脚本跑 */
const bridge = (before: string) =>
  `<script>window.ReactNativeWebView={postMessage:function(d){var f=window.frameElement;if(f&&f.__litchMessage)f.__litchMessage(String(d))}};${before}</script>`

function withBridge(html: string, before: string): string {
  const head = html.search(/<head[^>]*>/i)
  if (head < 0) return bridge(before) + html
  const end = html.indexOf('>', head) + 1
  return html.slice(0, end) + bridge(before) + html.slice(end)
}

export class WebView extends Component<WebViewProps> {
  private frame: Frame | null = null

  injectJavaScript(code: string): void {
    const target = this.frame?.contentWindow as (Window & { eval(code: string): unknown }) | null
    target?.eval(code)
  }

  requestFocus(): void {
    this.frame?.focus()
  }

  private attach = (element: Frame | null) => {
    this.frame = element
    if (element)
      element.__litchMessage = (data) => this.props.onMessage?.({ nativeEvent: { data } })
  }

  render() {
    const { source, injectedJavaScriptBeforeContentLoaded, style, testID } = this.props
    const html = withBridge(source?.html ?? '', injectedJavaScriptBeforeContentLoaded ?? '')
    return (
      <View style={style} testID={testID}>
        <iframe
          ref={this.attach}
          title={testID ?? 'webview'}
          srcDoc={html}
          style={{ border: 0, width: '100%', height: '100%', display: 'block' }}
        />
      </View>
    )
  }
}

export default WebView
