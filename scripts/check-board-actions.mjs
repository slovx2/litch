import assert from 'node:assert/strict'
import { browserFixture } from './ui-browser-fixture.mjs'

const mobile = process.argv.includes('--mobile')
const scroll = mobile ? '[data-testid=board-actions-scroll]' : '[data-scroll]'
const card = mobile ? '[data-testid="manager-issue:P-1"]' : '[data-report="P-1"]'
const actions = mobile ? '[data-testid=board-card-actions]' : '.mg-card-actions'
await browserFixture(
  {
    page: mobile
      ? 'http://127.0.0.1:5189/?app=1&scene=board-actions'
      : 'test/board-actions-fixture.html',
    width: mobile ? 390 : 920,
    height: 780,
    evidence: process.env.LITCH_BOARD_ACTIONS_EVIDENCE,
  },
  async ({ read, wait, shot, call }) => {
    await wait(`document.querySelectorAll('${actions}').length===5`)
    await wait(
      `document.querySelector(${JSON.stringify(card)}).textContent.includes('正文最后一行')`,
    )
    const settle = () => read('new Promise(r=>setTimeout(r,150))')
    const geometry = () =>
      read(`(()=>{
      const c=document.querySelector(${JSON.stringify(card)}), a=c.querySelector(${JSON.stringify(actions)}), s=document.querySelector(${JSON.stringify(scroll)});
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};
      return {card:rect(c),actions:rect(a),viewport:rect(s),scroll:s.scrollTop};
    })()`)
    await settle()
    await read(
      `(()=>{const c=document.querySelector(${JSON.stringify(card)}),s=document.querySelector(${JSON.stringify(scroll)}),r=c.getBoundingClientRect(),v=s.getBoundingClientRect();s.scrollTop+=r.top-v.top+(r.height-v.height)/2})()`,
    )
    await settle()
    let g = await geometry()
    assert.ok(
      Math.abs(g.actions.bottom - g.viewport.bottom + (mobile ? 0 : 16)) < 3,
      JSON.stringify(g),
    )
    await shot(mobile ? 'mobile-middle' : 'desktop-middle')
    // 操作栏要能真正命中按钮，而不只是看起来移动了。
    const point = await read(
      `(()=>{const r=document.querySelector(${JSON.stringify(card)}).querySelector(${JSON.stringify(actions)}).querySelector('button,[role=button]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await wait('window.__boardActionCalls.length===1')
    await read(
      `(()=>{const c=document.querySelector(${JSON.stringify(card)}),s=document.querySelector(${JSON.stringify(scroll)});s.scrollTop+=c.getBoundingClientRect().bottom-s.getBoundingClientRect().bottom+20})()`,
    )
    await settle()
    g = await geometry()
    assert.ok(g.actions.bottom <= g.card.bottom + 1, JSON.stringify(g))
    assert.ok(g.actions.top > g.card.top, JSON.stringify(g))
    const lastLine = await read(
      `(()=>{const c=document.querySelector(${JSON.stringify(card)}),a=c.querySelector(${JSON.stringify(actions)});const e=[...c.querySelectorAll('*')].find(e=>e.textContent==='正文最后一行：全部内容可见。');return {line:e.getBoundingClientRect().bottom,actions:a.getBoundingClientRect().top}})()`,
    )
    assert.ok(lastLine.line <= lastLine.actions, JSON.stringify(lastLine))
    await shot(mobile ? 'mobile-end' : 'desktop-end')
    // 每种卡片都只出一条操作栏，嵌套的正文不能另建一条。
    const selector = mobile ? '[data-testid^="board-kind:"]' : '[data-kind]'
    for (let i = 0; i < 4; i++) {
      const result = await read(`(()=>{
        const c=document.querySelectorAll(${JSON.stringify(selector)})[${i}],s=document.querySelector(${JSON.stringify(scroll)});
        s.scrollTop+=c.getBoundingClientRect().top-s.getBoundingClientRect().top+(c.getBoundingClientRect().height-s.getBoundingClientRect().height)/2;
        return c.querySelectorAll(${JSON.stringify(actions)}).length;
      })()`)
      assert.equal(result, 1)
      await settle()
      const bounds = await read(
        `(()=>{const c=document.querySelectorAll(${JSON.stringify(selector)})[${i}],a=c.querySelector(${JSON.stringify(actions)}),s=document.querySelector(${JSON.stringify(scroll)});return [a.getBoundingClientRect().bottom,s.getBoundingClientRect().bottom]})()`,
      )
      assert.ok(Math.abs(bounds[0] - bounds[1] + (mobile ? 0 : 16)) < 3, JSON.stringify(bounds))
    }
    // 缩短可用视口（与键盘避让后的几何一致），操作栏随可视底部更新。
    await call('Emulation.setDeviceMetricsOverride', {
      width: mobile ? 390 : 920,
      height: 520,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await settle()
    const resized = await read(
      `(()=>{const c=document.querySelectorAll(${JSON.stringify(selector)})[3],a=c.querySelector(${JSON.stringify(actions)}),s=document.querySelector(${JSON.stringify(scroll)});return [a.getBoundingClientRect().bottom,s.getBoundingClientRect().bottom]})()`,
    )
    assert.ok(Math.abs(resized[0] - resized[1] + (mobile ? 0 : 16)) < 3, JSON.stringify(resized))
    // 已滚出的上一卡片，其操作条也必须完全离开视口。
    g = await geometry()
    assert.ok(g.actions.bottom < g.viewport.top, JSON.stringify(g))
    console.log(
      `PASS ${mobile ? 'mobile' : 'desktop'} five card types, bounded actions, footer reserve and pointer hit`,
    )
  },
)
