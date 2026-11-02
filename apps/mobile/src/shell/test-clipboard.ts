import * as Clipboard from 'expo-clipboard'

/** mock 测试专用：避开 Android 剪贴板浮层，只观测原生内容；不调用产品复制实现。 */
export async function reportTestClipboard(params: URLSearchParams): Promise<void> {
  const port = Number(params.get('port'))
  const id = params.get('id')
  const action = params.get('action')
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !id) return
  if (action !== 'read' && action !== 'seed') return
  let result: { text?: string; error?: string }
  try {
    if (action === 'seed') await Clipboard.setStringAsync('e2e-clipboard-sentinel')
    result = { text: await Clipboard.getStringAsync() }
  } catch (error) {
    result = { error: String(error) }
  }
  await fetch(`http://127.0.0.1:${port}/clipboard/result?id=${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify(result),
  })
}
