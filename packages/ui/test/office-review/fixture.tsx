// 只供生产构建的浏览器验收；不进入产品入口。
import '../preview/fixture.tsx'
import { cleanDocx, cleanRendered } from '../../src/files/preview/office/docx-clean.ts'

Object.assign(window, {
  officeReviewCheck: async () => {
    const host = document.createElement('div')
    host.innerHTML = `<style>.docx { color: rgb(1, 2, 3); & .nested { background: url("data:image/svg+xml,bad"); width: 100000px; } @media (min-width: 0px) { font-size: 999999px; } } @media (min-width:0px) { .nested { background:url("https://office-probe.invalid/css"); } }</style><p class="docx">文档</p>`
    const before = host.querySelector('style')?.textContent
    cleanRendered(host)
    const after = host.querySelector('style')?.textContent ?? ''
    const enc = new TextEncoder()
    let pageLimit = ''
    try {
      await cleanDocx([
        {
          name: '[Content_Types].xml',
          bytes: enc.encode(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
          ),
        },
        {
          name: 'word/document.xml',
          bytes: enc.encode(
            `<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body>${'<x:br x:type="page"/>'.repeat(201)}</x:body></x:document>`,
          ),
        },
      ])
    } catch (error) {
      pageLimit = error instanceof Error ? error.message : ''
    }
    return { before, after, pageLimit }
  },
})
