import assert from 'node:assert/strict'
import { browserFixture } from './ui-browser-fixture.mjs'

await browserFixture(
  { page: 'test/explicit-link-fixture.html', evidence: process.env.LITCH_LINK_EVIDENCE },
  async ({ read, wait, click, shot, call }) => {
    await wait('document.querySelectorAll("[data-case]").length===6')
    for (let index = 0; index < 6; index++) {
      const selector = `[data-case="${index}"]`
      assert.equal(
        await read(
          `document.querySelector(${JSON.stringify(selector)}).querySelectorAll('a,button').length`,
        ),
        1,
        '显式链接标签只能有一个跳转目标',
      )
      await click(selector + ' a')
      await wait(
        `window.__explicitLinks.${index === 5 ? 'system' : 'calls'}.length===${index === 5 ? 1 : index + 1}`,
      )
      if (index < 5) {
        const call = await read(`window.__explicitLinks.calls[${index}]`)
        assert.ok(call.href.startsWith('/tmp/nebula-link-test/'))
        assert.ok(call.ref.path.startsWith('/tmp/nebula-link-test'))
      }
    }
    assert.equal(await read('window.__explicitLinks.opened.length'), 5)
    assert.equal(
      await read(
        `!!document.querySelector('[data-case="3"] strong') && !!document.querySelector('[data-case="3"] em')`,
      ),
      true,
    )
    assert.equal(await read(`!!document.querySelector('[data-case="2"] code')`), true)
    await shot('explicit-links')
    await read('window.__explicitLinks.fail()')
    await click('[data-case="0"] a')
    await wait('!!document.querySelector(".file-link-dialog[open]")')
    for (const width of [390, 1100]) {
      await call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const layout = await read(
        `(()=>{const d=document.querySelector('.file-link-dialog'),h=d.querySelector('.modal-head').getBoundingClientRect(),b=d.querySelector('.modal-body').getBoundingClientRect(),f=d.querySelector('.modal-foot').getBoundingClientRect();return {direction:getComputedStyle(d).flexDirection,ordered:h.top<b.top&&b.top<f.top,open:d.querySelector('details').open,overflow:d.scrollWidth>d.clientWidth+1}})()`,
      )
      assert.equal(layout.direction, 'column')
      assert.equal(layout.ordered, true)
      assert.equal(layout.open, false)
      assert.equal(layout.overflow, false)
      await shot('file-link-error-' + width)
    }
    await click('.modal-foot button')
    await wait('window.__explicitLinks.copied.length===1')
    assert.equal(await read('window.__explicitLinks.copied[0]'), '/tmp/nebula-link-test')
    await click('.file-link-details summary')
    assert.equal(await read('document.querySelector(".file-link-details").open'), true)
    await shot('file-link-error-details')
    console.log(
      'PASS explicit href is the only target; vertical error dialog with collapsed details',
    )
  },
)
