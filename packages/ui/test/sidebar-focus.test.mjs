import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

test('方向键停在侧栏时，迟到的输入框和请求卡不抢焦点；普通点击仍聚焦输入框', async () => {
  const result = await build({
    entryPoints: [new URL('../src/composer/focus.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'effects',
        setup(api) {
          api.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }))
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const useEffect=f=>f();',
          }))
        },
      },
    ],
  })
  const { useGrabFocus: mountComposer, useCardFocus: mountCard } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
  const saved = { document: globalThis.document, HTMLElement: globalThis.HTMLElement }
  class Element {
    tagName = 'BUTTON'
    keyboard = true
    closest(selector) {
      return this.keyboard && selector.includes('[data-sidebar-keyboard]') ? this : null
    }
  }
  globalThis.HTMLElement = Element
  globalThis.document = { activeElement: new Element() }
  let focused = 0
  const target = {
    current: {
      focus() {
        focused++
      },
    },
  }
  try {
    mountComposer(target)
    mountCard(target)
    assert.equal(focused, 0)
    globalThis.document.activeElement.keyboard = false
    mountComposer(target)
    assert.equal(focused, 1)
  } finally {
    Object.assign(globalThis, saved)
  }
})
