// 复审：窗口内互斥、经理窄视图、导航焦点、入口与皮肤焦点环。
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './chrome-m0/cdp.mjs'

export async function checkSearchR3({ cdp, evaluate, query, report, output, base }) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const key = async (key, code, modifiers = 0) => {
    const windowsVirtualKeyCode = { Escape: 27, Enter: 13, KeyF: 70, Tab: 9 }[code]
    for (const type of ['keyDown', 'keyUp'])
      await cdp.call('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode,
      })
  }
  const setInput = (selector, value) =>
    evaluate(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()})()`,
    )
  const shot = async (name) => {
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, name + '.png'), Buffer.from(r.data, 'base64'))
  }
  await cdp.call('Page.navigate', { url: `${base}/?lang=zh-CN` })
  await until(() => evaluate(`!!document.querySelector('.ss-row')`), '完整应用')
  await evaluate(
    `document.querySelector('[data-act="onboard-close"]')?.click();window.__litchLook.set({skin:'standard',theme:'light'});[...document.querySelectorAll('.ss-row')].find(el=>el.textContent.includes('远程设备安装指引')).click()`,
  )
  await until(
    () => evaluate(`document.querySelector('.crumb').textContent.includes('远程设备安装指引')`),
    '目标对话',
  )
  await evaluate(`document.querySelector('.tb-side').click()`)
  await until(
    () => evaluate(`!!document.querySelector('[role="tab"][data-tab="aside"]')`),
    '侧聊标签',
  )
  await evaluate(`document.querySelector('[role="tab"][data-tab="aside"]').click()`)
  await until(
    () =>
      evaluate(
        `!!document.querySelector('.aside-start button') || !!document.querySelector('.aside-view')`,
      ),
    '侧聊',
  )
  await evaluate(`document.querySelector('.aside-start button')?.click()`)
  await until(
    () => evaluate(`!!document.querySelector('.aside-view textarea.cmp-text')`),
    '侧聊输入框',
  )
  await setInput('.aside-view textarea.cmp-text', 'SearchAsideNeedle')
  await key('Enter', 'Enter')
  await until(
    () =>
      evaluate(
        `document.querySelector('.aside-view .tr').textContent.includes('SearchAsideNeedle')`,
      ),
    '侧聊用户消息',
  )
  await evaluate(`document.querySelector('.tb .search-entry').click()`)
  await query('远程设备')
  await evaluate(`document.querySelector('.aside-bar .search-entry').click()`)
  await until(
    () =>
      evaluate(
        `document.querySelectorAll('.search-bar').length===1 && !!document.querySelector('.aside-view .search-bar')`,
      ),
    '侧聊查找取代主对话',
  )
  await query('SearchAsideNeedle')
  assert.ok(
    await evaluate(
      `!![...CSS.highlights.get('litch-find-current')][0].startContainer.parentElement.closest('.aside-view')`,
    ),
  )
  await evaluate(`document.querySelector('.tb .search-entry').click()`)
  await until(
    () =>
      evaluate(
        `document.querySelectorAll('.search-bar').length===1 && !document.querySelector('.aside-view .search-bar')`,
      ),
    '主对话查找取代侧聊',
  )
  await query('远程设备')
  assert.ok(
    await evaluate(
      `![...CSS.highlights.get('litch-find-current')][0].startContainer.parentElement.closest('.aside-view')`,
    ),
  )
  await key('Escape', 'Escape')
  await evaluate(`document.querySelector('.aside-view textarea.cmp-text').focus()`)
  await key('f', 'KeyF', 4)
  await query('SearchAsideNeedle')
  assert.equal(await evaluate(`document.querySelectorAll('.search-bar').length`), 1)
  await shot('r3-exclusive-aside')
  await key('Escape', 'Escape')
  report.checks.push({ name: 'N1 主对话→侧聊→主对话→关闭→侧聊，始终单栏，高亮正确重建' })

  await evaluate(
    `document.querySelector('.tb-side[aria-pressed="true"]')?.click();document.querySelector('[data-sidebar-mode="manager"]').click()`,
  )
  await until(() => evaluate(`!!document.querySelector('.mg-pick')`), '经理列表')
  await evaluate(`document.querySelector('.mg-pick').click()`)
  await until(() => evaluate(`!!document.querySelector('.mg-narrow')`), '经理页面')
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const board = () =>
    evaluate(
      `document.querySelectorAll('.mg-narrow button')[1].click();document.querySelectorAll('.mg-narrow button')[1].focus()`,
    )
  for (const entry of ['keyboard', 'button']) {
    await board()
    if (entry === 'keyboard') await key('f', 'KeyF', 4)
    else await evaluate(`document.querySelector('.tb .search-entry').click()`)
    await until(
      () =>
        evaluate(
          `document.querySelector('.mg-chat .search-bar input')?.checkVisibility() && document.activeElement===document.querySelector('.mg-chat .search-bar input')`,
        ),
      `经理看板通过${entry}先切对话再聚焦查找`,
    )
    assert.equal(
      await evaluate(
        `document.querySelectorAll('.mg-narrow button')[0].getAttribute('aria-pressed')`,
      ),
      'true',
    )
    await key('Escape', 'Escape')
  }
  await board()
  await evaluate(`document.querySelector('.tb .search-entry').click()`)
  await shot('r3-manager-narrow-find')
  await key('Escape', 'Escape')
  report.checks.push({ name: 'N2 760px经理看板，快捷键/图标先切对话并聚焦' })

  await evaluate(`document.querySelector('.tb-sidebar').click()`)
  assert.ok(await evaluate(`document.querySelector('.tb .search-sidebar')?.checkVisibility()`))
  assert.ok(
    await evaluate(
      `document.querySelector('.tb .search-sidebar svg').innerHTML!==document.querySelector('.tb .search-entry svg').innerHTML`,
    ),
  )
  await evaluate(`document.querySelector('.tb .search-sidebar').click()`)
  await until(() => evaluate(`!!document.querySelector('.search-dialog')`), '侧栏收起的鼠标入口')
  await setInput('.search-dialog input', 'KeepAlive')
  await until(
    () =>
      evaluate(
        `document.querySelector('.search-results [role="option"]')?.textContent.includes('KeepAlive')`,
      ),
    '无项目搜索结果',
  )
  const row = await evaluate(
    `(()=>{const r=document.querySelector('.search-results [role="option"]');return {lines:r.children.length,text:r.textContent,height:r.getBoundingClientRect().height}})()`,
  )
  assert.equal(row.lines, 2)
  assert.ok(row.text.includes('无项目'))
  assert.ok(row.height < 80)
  await shot('r3-title-two-lines')
  await key('Enter', 'Enter')
  await until(
    () =>
      evaluate(
        `document.querySelector('.crumb').textContent.includes('KeepAlive') && document.activeElement?.matches('textarea.cmp-text')`,
      ),
    'Enter打开会话后焦点进目标输入框',
  )
  await pause(150)
  assert.ok(await evaluate(`document.activeElement?.matches('textarea.cmp-text')`))
  // 同一个会话也能正确聚焦，不依赖Composer重新挂载。
  await evaluate(`document.querySelector('.tb .search-sidebar').click()`)
  await setInput('.search-dialog input', 'KeepAlive')
  await until(
    () =>
      evaluate(
        `document.querySelector('.search-results [role="option"]')?.textContent.includes('KeepAlive')`,
      ),
    '当前会话结果',
  )
  await key('Enter', 'Enter')
  await until(
    () => evaluate(`document.activeElement?.matches('textarea.cmp-text')`),
    '打开当前会话也聚焦输入框',
  )
  report.checks.push({
    name: '建议1/2/3/4/5 两行结果、无项目、打开输入焦点、折叠侧栏入口、图标不同',
    row,
  })

  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      await evaluate(
        `window.__litchLook.set({skin:'${skin}',theme:'${theme}'});document.querySelector('.tb .search-entry').click()`,
      )
      await query('launchd')
      await pause(200)
      const underline = await evaluate(
        `getComputedStyle(document.querySelector('.tr'), '::highlight(litch-find-current)').textDecorationLine`,
      )
      assert.ok(underline.includes('underline'))
      const checkFocus = async (selector) => {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
        const style = await evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const probe=document.createElement('span');probe.style.color='var(--accent)';e.parentElement.append(probe);const expected=getComputedStyle(probe).color;probe.remove();const s=getComputedStyle(e);return {color:s.outlineColor,width:s.outlineWidth,expected,focused:e.matches(':focus-visible')}})()`,
        )
        assert.ok(style.focused)
        assert.equal(style.width, '2px')
        assert.equal(style.color, style.expected)
      }
      await checkFocus('.search-bar input')
      await shot(`r3-focus-find-${skin}-${theme}`)
      await key('Escape', 'Escape')
      await evaluate(`document.querySelector('.tb .search-sidebar').click()`)
      await checkFocus('.search-controls input')
      await key('Tab', 'Tab')
      await checkFocus('.search-controls select')
      await shot(`r3-focus-titles-${skin}-${theme}`)
      await key('Escape', 'Escape')
      report.checks.push({ name: `N3/N4 当前项下划线及三控件皮肤焦点环 ${skin}/${theme}` })
    }
  await setInput('.main textarea.cmp-text', '用子代理看看')
  await key('Enter', 'Enter')
  await until(
    () => evaluate(`document.querySelectorAll('.main .agents-rows .agent-row').length===3`),
    '模拟核心派出子代理',
  )
  await evaluate(`document.querySelector('.main .agents-rows .agent-row').click()`)
  await until(
    () =>
      evaluate(
        `!!document.querySelector('.agents-view .agents-title .search-entry') && !!document.querySelector('.agents-view .agent-st')`,
      ),
    '子代理详情栏',
  )
  assert.ok(
    await evaluate(
      `(()=>{const head=document.querySelector('.agents-view .agents-title');return head.querySelector('.search-entry').getBoundingClientRect().left < head.querySelector('.agent-st').getBoundingClientRect().left})()`,
    ),
  )
  await evaluate(`document.querySelector('.agents-view .search-entry').focus()`)
  await key('f', 'KeyF', 4)
  await until(
    () =>
      evaluate(
        `document.activeElement===document.querySelector('.agents-view .search-bar input') && document.querySelectorAll('.search-bar').length===1`,
      ),
    '子代理详情快捷键命中自身',
  )
  await shot('r3-agent-find-position')
  report.checks.push({ name: '建议5 子代理详情查找位于状态左侧，快捷键进入自身查找框' })
}
