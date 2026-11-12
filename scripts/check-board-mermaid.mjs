import assert from 'node:assert/strict'
import { browserFixture } from './ui-browser-fixture.mjs'

const mobile = process.argv.includes('--mobile')
await browserFixture(
  {
    page: mobile
      ? (process.env.LITCH_MOBILE_PREVIEW ?? 'http://127.0.0.1:5189/?app=1&scene=board-mermaid')
      : 'test/board-mermaid-fixture.html',
    width: mobile ? 390 : 1100,
    height: 940,
    evidence: process.env.LITCH_MERMAID_EVIDENCE,
  },
  async ({ read, wait, click, shot }) => {
    if (mobile) {
      await wait('document.querySelectorAll("[data-testid=mermaid-card]").length===2')
      await wait(
        `(()=>{const e=document.querySelector('[data-testid="mermaid-card:open"]');return e && !e.disabled && e.getAttribute('aria-disabled')!=='true'})()`,
      )
      await wait('document.body.innerText.includes("not a valid diagram")')
      await shot('mobile-board-mermaid')
      await click('[data-testid="mermaid-card:open"]')
      await wait('!!document.querySelector("[data-testid=mermaid-viewer]")')
      await shot('mobile-board-mermaid-viewer')
    } else {
      await wait('document.querySelectorAll(".mmd-fig svg").length===6')
      await wait('!!document.querySelector(".mmd-err")')
      assert.equal(
        await read(
          'document.querySelector(".mmd-err").closest(".mmd").querySelector("code").textContent',
        ),
        'not a valid diagram',
      )
      for (const skin of ['standard', 'human', 'retro']) {
        await read(
          `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:'dark',lang:'zh-CN'})`,
        )
        await wait('document.querySelectorAll(".mmd-fig svg").length===6')
        await shot('desktop-board-mermaid-' + skin)
      }
    }
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'} board shared Mermaid and source fallback`)
  },
)
