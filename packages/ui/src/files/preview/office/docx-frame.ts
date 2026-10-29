// 此入口打成独立经典脚本，在 opaque sandbox 中运行；不导入应用服务或 preload。
import { renderAsync } from 'docx-preview'
import { errorKind, type Part } from './archive.ts'
import { cleanDocx, cleanRendered } from './docx-clean.ts'

let used = false
addEventListener('message', async (event: MessageEvent) => {
  if (used || event.source !== parent || event.data !== 'litch-office' || event.ports.length !== 1)
    return
  used = true
  const port = event.ports[0]
  if (!port) return
  port.onmessage = async ({ data }: MessageEvent<Part[]>) => {
    port.onmessage = null
    try {
      const bytes = await cleanDocx(data)
      const host = document.createElement('div')
      await renderAsync(bytes, host, host, {
        renderAltChunks: false,
        ignoreFonts: true,
        useBase64URL: true,
        renderComments: false,
        renderChanges: false,
        experimental: false,
        breakPages: true,
        inWrapper: true,
        ignoreLastRenderedPageBreak: true,
      })
      cleanRendered(host)
      if (host.querySelectorAll('*').length > 100_000) throw Error('budget')
      document.body.replaceChildren(host)
      // 文档链接不导航；禁止内容获得第二条外部通信入口。
      document.addEventListener('click', (event) => event.preventDefault(), true)
      let isolated = false
      try {
        void parent.document
      } catch {
        isolated = true
      }
      port.postMessage({ ok: true, isolated, pages: host.querySelectorAll('section.docx').length })
    } catch (error) {
      port.postMessage({ ok: false, error: errorKind(error) })
    }
    port.close()
  }
  port.start()
  port.postMessage('ready')
})
