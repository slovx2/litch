// 宽幅中文图使用正式对话组件和真实 Chromium 输入；只访问回环夹具。
import assert from 'node:assert/strict'
import { browserFixture } from './ui-browser-fixture.mjs'

await browserFixture(
  {
    page: 'test/mermaid-viewer-fixture.html',
    width: 1100,
    height: 720,
    evidence: process.env.LITCH_MERMAID_EVIDENCE,
  },
  async ({ read, call, wait, click, shot }) => {
    const viewer = '.mmd-viewer[open]'
    const open = '[data-act=mermaid-zoom]'
    const close = '.mmd-viewer-close'
    const box = (selector) =>
      read(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
    const diagram = () => box(`${viewer} svg.flowchart`)
    const nextFrame = () =>
      read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const fit = async (width, height) => {
      await nextFrame()
      const dialog = await box(viewer)
      const canvas = await box('.mmd-canvas')
      const button = await box(close)
      const graph = await diagram()
      assert.deepEqual([dialog.x, dialog.y, dialog.width, dialog.height], [0, 0, width, height])
      assert.ok(button.top >= 0 && button.bottom <= canvas.top && button.right <= width)
      assert.ok(graph.left >= canvas.left && graph.right <= canvas.right)
      assert.ok(graph.top >= canvas.top && graph.bottom <= canvas.bottom)
      assert.ok(Math.abs(graph.x + graph.width / 2 - (canvas.x + canvas.width / 2)) < 1)
      assert.ok(Math.abs(graph.y + graph.height / 2 - (canvas.y + canvas.height / 2)) < 1)
      const ratio = await read(`(() => {
        const {width,height}=document.querySelector('${viewer} svg.flowchart').viewBox.baseVal
        return width / height
      })()`)
      assert.ok(Math.abs(graph.width / graph.height - ratio) < 0.001)
      return graph
    }
    const resize = (width, height) =>
      call('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    const mouse = (type, x, y, extra) => call('Input.dispatchMouseEvent', { type, x, y, ...extra })
    const esc = async () => {
      const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
      await call('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    await wait('document.querySelectorAll(".mmd-fig svg .node").length===7')
    for (const skin of ['standard', 'human', 'retro']) {
      for (const theme of ['light', 'dark']) {
        const first = skin === 'standard' && theme === 'light'
        if (!first) {
          const previous = await read('document.querySelector(".mmd-fig svg").id')
          await read(`window.__litchLook.set({skin:'${skin}',theme:'${theme}',lang:'zh-CN'})`)
          await wait(`document.querySelector(".mmd-fig svg").id!==${JSON.stringify(previous)}`)
        }
        for (const [width, height, size] of [
          [1100, 720, 'wide'],
          [440, 460, 'narrow'],
        ]) {
          await resize(width, height)
          await read(`document.querySelector('${open}').focus()`)
          await click(open)
          await wait(`!!document.querySelector('${viewer} svg.flowchart')`)
          const initial = await fit(width, height)
          await shot(`${skin}-${theme}-${size}`)
          if (first && size === 'wide') {
            const x = 325
            const y = 365
            await mouse('mouseWheel', x, y, { deltaX: 0, deltaY: -280 })
            await wait(
              `document.querySelector('${viewer} svg.flowchart').getBoundingClientRect().width > ${initial.width + 10}`,
            )
            const zoom = await diagram()
            assert.ok(Math.abs((x - zoom.x) / zoom.width - (x - initial.x) / initial.width) < 0.001)
            assert.ok(
              Math.abs((y - zoom.y) / zoom.height - (y - initial.y) / initial.height) < 0.001,
            )
            // Chromium 把触控板捏合送成带 Ctrl 的 wheel。
            await mouse('mouseWheel', x, y, { deltaX: 0, deltaY: -100, modifiers: 2 })
            await wait(
              `document.querySelector('${viewer} svg.flowchart').getBoundingClientRect().width > ${zoom.width + 10}`,
            )
            const pinched = await diagram()
            await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
            await mouse('mouseMoved', x + 95, 20, { button: 'left', buttons: 1 })
            await wait(
              `Math.abs(document.querySelector('${viewer} svg.flowchart').getBoundingClientRect().x - ${pinched.x + 95}) < 1`,
            )
            await mouse('mouseReleased', x + 95, 20, { button: 'left', clickCount: 1 })
            const moved = await diagram()
            assert.ok(Math.abs(moved.x - pinched.x - 95) < 1)
            assert.ok(Math.abs(moved.y - pinched.y - (20 - y)) < 1)
            const button = await box(close)
            assert.ok(
              await read(
                `document.elementFromPoint(${button.x + 3},${button.y + 3}).closest('${close}')!==null`,
              ),
            )
            await shot('zoomed-and-panned')
            for (const clickCount of [1, 2]) {
              await mouse('mousePressed', x, y, { button: 'left', clickCount })
              await mouse('mouseReleased', x, y, { button: 'left', clickCount })
            }
            await fit(width, height)
            await resize(440, 460)
            await fit(440, 460)
          }
          if (size === 'wide') await esc()
          else await click(close)
          await wait("!document.querySelector('.mmd-viewer')")
          assert.equal(await read(`document.activeElement.matches('${open}')`), true)
        }
      }
    }
    console.log(
      'PASS 宽图等比居中、窗口调整、滚轮及捏合缩放、拖动、复位、Esc 和关闭；三种皮肤、两种明暗、两档窗口',
    )
  },
)
