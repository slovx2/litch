import assert from 'node:assert/strict'
import { until } from './chrome-m0/cdp.mjs'

export async function checkUiCsp({ window, evaluate, report }) {
  await window.loadURL('app://ui/test/preview/index.html')
  await until(() => evaluate('!!document.querySelector(".fp-document h1")'), 'Markdown')
  await until(() => evaluate('!!document.querySelector(".mmd-fig svg")'), 'Mermaid', 30000)
  await evaluate('document.querySelector(".fp-document").scrollTop = 10000')
  await until(
    () => evaluate('document.querySelector(".fp-inline-image")?.naturalWidth > 0'),
    'SVG 附图',
  )
  await evaluate(`window.previewCheck.open('fixtures/long.ts', 2)`)
  await until(
    () => evaluate('!!document.querySelector(".fv-code .hljs-keyword")'),
    '代码高亮 Worker',
  )
  assert(report.responses.some((r) => /highlight\.worker-/.test(r.url)))
  await evaluate(`window.previewCheck.open('docs/images/preview.svg')`)
  await until(
    () => evaluate('document.querySelector(".fp-image-stage img")?.naturalWidth === 480'),
    'SVG 图片',
  )
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='
  await evaluate(
    `window.previewCheck.result('pixel.png', {kind:'ready', format:'image', bytes:68, dataBase64:'${png}'});window.previewCheck.open('pixel.png')`,
  )
  await until(
    () => evaluate('document.querySelector(".fp-image-stage img")?.naturalWidth === 1'),
    'PNG 图片',
  )
  report.checks.push('响应头与 meta 交集：Markdown、Mermaid、高亮 Worker、PNG/SVG 正常')
  await window.loadURL('app://ui/test/pdf/csp.html')
  await until(
    () => evaluate('document.querySelector(".automation-stage img")?.naturalWidth === 640'),
    'Computer Use 预览 JPEG',
  )
  assert(await evaluate('!!document.querySelector("[data-litch-automation-pointer]")'))
  report.checks.push('Computer Use 示例预览与光标渲染正常，无系统操作')
}
