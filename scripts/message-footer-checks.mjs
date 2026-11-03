import assert from 'node:assert/strict'
import { until } from './chrome-m0/cdp.mjs'

/** 正式组件、真实布局与指针/键盘行为；不保存截图，不触碰系统剪贴板。 */
export async function checkMessageFooter(cdp, evaluate, base) {
  await cdp.call('Page.navigate', { url: `${base}test/message-footer-fixture.html?lang=zh-CN` })
  await until(() => evaluate('document.querySelectorAll(".turn").length === 5'), '五种收尾场景')
  await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true, value: async text => { window.copiedFooter = text }
  })`)
  const frames = () =>
    evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const rows = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      for (const width of [1200, 380]) {
        await cdp.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, theme })})`)
        await evaluate('document.fonts.ready')
        await frames()
        const result = await evaluate(`(() => {
          const turns = [...document.querySelectorAll('.turn')];
          const completed = turns[0], answer = [...completed.querySelectorAll('.agent-message')].at(-1);
          const foot = completed.querySelector('.turn-foot'), box = foot.getBoundingClientRect();
          const button = foot.querySelector('button').getBoundingClientRect();
          const live = turns.at(-1), message = live.querySelector('.agent-message');
          const hidden = live.querySelector('.running-line[data-hidden]');
          const inLine = [...foot.children].every(e => {
            const r = e.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom;
          });
          return {
            height: box.height, tail: box.bottom - answer.querySelector('.md').getBoundingClientRect().bottom,
            inLine, right: box.right, buttonRight: button.right,
            copies: turns.map(t => t.querySelectorAll('.agent-message .message-copy, .turn-foot .message-copy').length),
            states: turns.map(t => t.querySelector('.turn-foot')?.textContent.trim() ?? ''),
            floatingHeight: message.getBoundingClientRect().height - message.querySelector('.md').getBoundingClientRect().height,
            hiddenHeight: hidden?.getBoundingClientRect().height,
            emptyTail: live.getBoundingClientRect().bottom - message.getBoundingClientRect().bottom
          };
        })()`)
        assert.equal(result.height, 22)
        assert.equal(result.tail, 34)
        assert.ok(result.inLine, '状态、用时、时间和按钮同一行')
        assert.ok(result.right <= width && result.buttonRight <= result.right, '窄宽度不溢出')
        assert.deepEqual(result.copies, [2, 1, 1, 0, 1], '每条消息只保留自己的复制入口')
        assert.match(result.states[0], /完成.*7.*27/)
        assert.match(result.states[1], /出错/)
        assert.match(result.states[2], /中断/)
        assert.match(result.states[3], /完成/)
        assert.equal(result.states[4], '')
        assert.equal(result.floatingHeight, 0, '输出中的操作不占行')
        assert.equal(result.hiddenHeight, 0, '没有工作提示时不占行')
        assert.equal(result.emptyTail, 0, '隐藏提示也不留下 flex 间距')
        rows.push({ skin, theme, width, height: result.height, tail: result.tail })
      }
    }
  }
  await evaluate('window.footerFixture.older()')
  for (const skin of ['retro', 'human', 'standard']) {
    for (const lang of ['zh-CN', 'en']) {
      await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, lang, chatText: 1.5 })})`)
      await evaluate('document.fonts.ready')
      await frames()
      assert.ok(
        await evaluate(`(() => [...document.querySelectorAll('.turn-foot')].every(foot => {
          const box=foot.getBoundingClientRect();
          return [...foot.children].every(e => {
            const r=e.getBoundingClientRect();
            return r.left>=box.left && r.right<=box.right && r.top>=box.top && r.bottom<=box.bottom;
          });
        }))()`),
        `${skin}/${lang}：380px、大字号、跨年日期仍同行且不遮挡按钮`,
      )
    }
  }
  await evaluate("window.__litchLook.set({chatText:1,lang:'zh-CN'})")
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluate(`window.__litchLook.set({skin:'retro',theme:'light'});
    document.querySelector('.turn').scrollIntoView()`)
  await frames()
  const geometry = () =>
    evaluate(`(() => {
      const foot = document.querySelector('.turn-foot'), r = foot.getBoundingClientRect();
      return {top:r.top,height:r.height,opacity:getComputedStyle(foot.querySelector('.message-acts')).opacity};
    })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
  const before = await geometry()
  assert.equal(before.opacity, '0')
  const point = await evaluate(`(() => {
    const r=document.querySelector('.turn-foot button').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  const hovered = await geometry()
  assert.equal(hovered.opacity, '1')
  assert.equal(hovered.top, before.top)
  assert.equal(hovered.height, before.height)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
  await evaluate(`document.querySelector('.turn-foot button').focus({preventScroll:true})`)
  const focused = await geometry()
  assert.equal(focused.opacity, '1', '键盘聚焦也显出操作')
  assert.equal(focused.top, before.top)
  await evaluate('document.activeElement.click()')
  await until(() => evaluate('window.copiedFooter'), '聚焦按钮复制')
  assert.equal(await evaluate('window.copiedFooter'), '回答 0：**完整 Markdown**。')
  await evaluate(`document.querySelector('.agent-message .message-copy').click()`)
  assert.equal(await evaluate('window.copiedFooter'), '较早回答')
  await evaluate(`document.querySelector('.turn:last-child .agent-message .message-copy').click()`)
  assert.equal(await evaluate('window.copiedFooter'), '回答 4：**完整 Markdown**。')
  // 触摸设备没有 hover，操作持续可见，仍不增加行高。
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await evaluate('document.activeElement?.blur()')
  assert.equal(await evaluate('matchMedia("(hover: none)").matches'), true)
  assert.equal((await geometry()).opacity, '1')
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: false })
  await evaluate(`window.liveBody=document.querySelector('.turn:last-child .md');
    window.liveWidth=window.liveBody.getBoundingClientRect().width;
    window.footerFixture.finish()`)
  await until(() => evaluate('!!document.querySelector(".turn:last-child .turn-foot")'), '输出定稿')
  assert.ok(await evaluate('window.liveBody === document.querySelector(".turn:last-child .md")'))
  assert.ok(
    await evaluate('window.liveWidth === window.liveBody.getBoundingClientRect().width'),
    '移入状态行时正文不重新换行',
  )
  assert.equal(
    await evaluate('document.querySelectorAll(".turn:last-child .turn-foot .message-copy").length'),
    1,
  )
  console.log('message-footer', JSON.stringify(rows))
}
