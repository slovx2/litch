// 搜索审核回归：真实按键、持续增量、稀疏历史和六套外观；由 check-search-ui 调用。
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './chrome-m0/cdp.mjs'

export async function checkSearchReview({ cdp, evaluate, query, report, output, base }) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const key = async (key, code, modifiers = 0) => {
    const windowsVirtualKeyCode = { Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38, KeyF: 70 }[
      code
    ]
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    })
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    })
  }
  const open = async (suffix = '') => {
    await cdp.call('Page.navigate', { url: `${base}/test/search-fixture.html?lang=zh-CN${suffix}` })
    await until(() => evaluate(`!!document.querySelector('.search-entry')`), '夹具入口')
    await evaluate(
      `document.querySelector('.search-entry').focus(); document.querySelector('.search-entry').click()`,
    )
    await until(() => evaluate(`!!document.querySelector('.search-bar input')`), '查找输入框')
  }
  const current = () =>
    evaluate(
      `(()=>{const r=[...(CSS.highlights.get('litch-find-current')??[])][0];return {text:r?.toString(),item:r?.startContainer.parentElement.closest('[data-search-item]')?.dataset.searchItem,top:r?.getBoundingClientRect().top,count:document.querySelector('.search-count')?.textContent,running:!!document.querySelector('.running-line')}})()`,
    )
  await open()
  await query('用户消息')
  let hit = await current()
  assert.equal(hit.item, 't4999:u4999', '贴底从最新命中开始')
  assert.equal(hit.count, '500 / 500')
  assert.ok(await evaluate(`CSS.highlights.get('litch-find').size > 1`), '同屏其他消息也高亮')
  assert.equal(
    await evaluate(`!!document.querySelector('[data-search-item="t4999:u4999"] button.mini')`),
    false,
  )
  await key('Enter', 'Enter')
  await until(
    async () => (await current()).item === 't4500:u4500',
    '500 上限包含最近500处并按对话顺序循环',
  )
  await query('用户消')
  hit = await current()
  assert.equal(hit.item, 't4500:u4500', '中部视口继续选择附近命中')
  report.checks.push({ name: 'S2 最近500处、首次视口最近项、顺序循环', hit })

  await query('最早中文')
  const before = await evaluate(
    `document.querySelector('[data-search-item="t0:u0"]').getBoundingClientRect().top - document.querySelector('.tr-scroll').getBoundingClientRect().top`,
  )
  await key('Escape', 'Escape')
  await pause(3300)
  const closed = await evaluate(
    `({top:document.querySelector('[data-search-item="t0:u0"]')?.getBoundingClientRect().top - document.querySelector('.tr-scroll').getBoundingClientRect().top,gaps:document.querySelectorAll('.search-gap').length,bar:!!document.querySelector('.search-bar'),focus:document.activeElement.className})`,
  )
  assert.equal(closed.bar, false)
  assert.equal(closed.gaps, 0)
  assert.ok(Math.abs(closed.top - before) < 4, `关闭后位置偏移 ${closed.top - before}`)
  assert.ok(closed.focus.includes('search-entry'), '关闭归还入口焦点')
  report.checks.push({
    name: 'S3 关闭3.3秒后仍在原命中、无搜索分隔行、焦点返回入口',
    before,
    ...closed,
  })

  for (const platform of ['darwin', 'win32', 'linux']) {
    await evaluate(`window.litchShell={platform:${JSON.stringify(platform)}}`)
    const right = platform === 'darwin' ? 4 : 2,
      wrong = platform === 'darwin' ? 2 : 4
    await key('f', 'KeyF', wrong)
    assert.equal(await evaluate(`!!document.querySelector('.search-bar')`), false)
    await key('F', 'KeyF', wrong | 8)
    assert.equal(await evaluate(`!!document.querySelector('.search-dialog')`), false)
    await key('f', 'KeyF', right)
    await until(
      () => evaluate(`!!document.querySelector('.search-bar input')`),
      `${platform} 对话快捷键`,
    )
    await key('Escape', 'Escape')
    await key('F', 'KeyF', right | 8)
    await until(
      () => evaluate(`!!document.querySelector('.search-dialog[open]')`),
      `${platform} 全局快捷键`,
    )
    await key('Escape', 'Escape')
    await until(() => evaluate(`!document.querySelector('.search-dialog')`), '关闭全局搜索')
  }
  report.checks.push({ name: 'S4 macOS只认Cmd，Windows/Linux只认Ctrl（平台注入+CDP按键）' })

  // 使用正式模拟核心的 s1 流式，不以手工增量代替；默认60ms和更快的10ms各验一轮。
  for (const chunkMs of [60, 10]) {
    await open(`&mock=1&chunkMs=${chunkMs}`)
    await query('入口')
    // 同时覆盖正在替换 Markdown 段落的助手回答，不能只在稳定的用户气泡上采样。
    for (let step = 0; step < 4 && (await current()).item !== 's1-t2-a2'; step++) {
      await key('Enter', 'Enter')
      await pause(80)
    }
    await until(async () => (await current()).item === 's1-t2-a2', '命中正在流式的助手回答')
    const first = await current(),
      samples = []
    report.checks.push({ name: `S0 采样开始 ${chunkMs}ms`, first, samples })
    assert.ok(first.running, `模拟核心 ${chunkMs}ms 查询发生在流式期间`)
    for (let n = 0; n < 8; n++) {
      await pause(100)
      const sample = await current()
      samples.push(sample)
      assert.equal(sample.text, '入口', '流式中高亮不能消失或收缩为空')
      assert.equal(sample.item, first.item, '相同查询不重选当前项')
      assert.ok(!sample.count.includes('正在'), '流式中计数不反复切为搜索中')
      assert.ok(Math.abs(sample.top - first.top) < 4, `流式视口移动 ${sample.top - first.top}`)
      const previousTotal = Number((samples.at(-2) ?? first).count.split('/')[1])
      assert.ok(Number(sample.count.split('/')[1]) >= previousTotal, '追加流式中总数不能倒退')
    }
    await evaluate(`window.__litchLook.set({skin:'human',theme:'dark'})`)
    await pause(250)
    assert.equal((await current()).text, '入口', '换皮肤后仍有高亮')
    report.checks.push({ name: `S0 正式模拟核心流式 ${chunkMs}ms`, samples })
  }

  await open()
  await query('用户消息')
  const luminance = (rgb) =>
    rgb
      .map((v) => {
        v /= 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const contrast = (a, b) => {
    const x = luminance(a),
      y = luminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__litchLook.set({skin:'${skin}',theme:'${theme}'})`)
      await pause(250)
      const colors = await evaluate(
        `(()=>{const el=document.createElement('span');document.body.append(el);const rgb=v=>{el.style.color='var('+v+')';return getComputedStyle(el).color.match(/[\\d.]+/g).map(Number)};const result=['--find','--on-find','--panel','--raised','--accent-solid','--on-accent'].map(rgb);el.remove();return result})()`,
      )
      const background = Math.min(contrast(colors[0], colors[2]), contrast(colors[0], colors[3]))
      const text = contrast(colors[0], colors[1]),
        activeText = contrast(colors[4], colors[5])
      assert.ok(background >= 3, `${skin}/${theme} 高亮底色对比 ${background}`)
      assert.ok(text >= 4.5 && activeText >= 4.5, `${skin}/${theme} 高亮文字对比`)
      assert.ok(await evaluate(`CSS.highlights.get('litch-find').size > 1`))
      const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(output, `review-${skin}-${theme}.png`), Buffer.from(shot.data, 'base64'))
      report.checks.push({ name: `S1 六种外观 ${skin}/${theme}`, background, text, activeText })
    }

  await key('Escape', 'Escape')
  await evaluate(
    `document.querySelector('.search-entry').focus();window.searchFixture.openTitles()`,
  )
  await until(
    () => evaluate(`document.querySelectorAll('.search-results [role="option"]').length > 0`),
    '空查询显示最近会话',
  )
  const top = await evaluate(`document.querySelector('.search-dialog').getBoundingClientRect().top`)
  await key('ArrowDown', 'ArrowDown')
  assert.equal(
    await evaluate(
      `document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')`,
    ),
    'title-search-result-1',
  )
  await key('Enter', 'Enter')
  await until(
    () => evaluate(`!!window.searchFixture.opened && !document.querySelector('.search-dialog')`),
    'Enter打开所选结果',
  )
  await pause(50)
  // 此夹具只记录打开事件，不挂载目标会话；实际输入框焦点由完整应用复审场景验证。
  assert.equal(await evaluate(`!!document.activeElement.closest('.search-dialog')`), false)
  await evaluate(`window.searchFixture.openTitles()`)
  await until(() => evaluate(`!!document.querySelector('.search-dialog')`), '再次打开标题搜索')
  await until(
    () => evaluate(`!document.querySelector('.search-dialog .btn').disabled`),
    '首次读取完成',
  )
  await evaluate(
    `window.searchFixture.failRefresh(true);document.querySelector('.search-dialog .btn').click()`,
  )
  await until(
    () => evaluate(`document.querySelector('.search-dialog .btn').disabled`),
    '读取中禁用按钮',
  )
  await until(
    () => evaluate(`document.querySelector('.search-coverage').textContent.includes('读取失败')`),
    '读取失败单独提示',
  )
  await evaluate(
    `window.searchFixture.failRefresh(false);document.querySelector('.search-dialog .btn').click()`,
  )
  await until(
    () =>
      evaluate(
        `!document.querySelector('.search-dialog .btn').disabled && !document.querySelector('.search-coverage').textContent.includes('读取失败')`,
      ),
    '重试成功清除失败',
  )
  assert.ok(
    Math.abs(
      (await evaluate(`document.querySelector('.search-dialog').getBoundingClientRect().top`)) -
        top,
    ) < 2,
    '异步结果不移动输入框',
  )
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const narrow = await evaluate(
    `(()=>{const d=document.querySelector('.search-dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,overflow:d.scrollWidth>d.clientWidth}})()`,
  )
  assert.ok(narrow.left >= 0 && narrow.right <= 760 && !narrow.overflow)
  report.checks.push({
    name: 'S6/S7/B4/B5/B8/B9 固定modal、最近会话、键盘打开和焦点、失败重试、760窄窗',
    narrow,
  })
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.call('Page.navigate', { url: `${base}/?lang=zh-CN` })
  await until(
    () => evaluate(`!!document.querySelector('.sb-top .search-sidebar')`),
    '完整应用侧栏入口',
  )
  await evaluate(
    `document.querySelector('[data-act="onboard-close"]')?.click();window.__litchLook.set({skin:'standard',theme:'light'})`,
  )
  await evaluate(
    `[...document.querySelectorAll('.ss-row:not(.projection-group *)')].find(el=>el.textContent.includes('把运行时')).click()`,
  )
  await until(() => evaluate(`!!document.querySelector('.tb .search-entry')`), '标题栏查找入口')
  assert.ok(
    await evaluate(
      `document.querySelector('.tb .search-entry').title.includes('⌘F') && document.querySelector('.search-sidebar').getAttribute('aria-keyshortcuts')==='Meta+Shift+F'`,
    ),
  )
  assert.equal(await evaluate(`!!document.querySelector('.main > .search-entry')`), false)
  await cdp
    .call('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(join(output, 'review-entries.png'), Buffer.from(r.data, 'base64')))
  await evaluate(`document.querySelector('.search-sidebar').click()`)
  await until(() => evaluate(`!!document.querySelector('.search-dialog input')`), '标题入口可用')
  await evaluate(
    `(()=>{const input=document.querySelector('.search-dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'launchd');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await until(
    () => evaluate(`document.querySelectorAll('.search-results mark').length > 0`),
    '标题高亮',
  )
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__litchLook.set({skin:'${skin}',theme:'${theme}'})`)
      await pause(300)
      const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        join(output, `review-titles-${skin}-${theme}.png`),
        Buffer.from(shot.data, 'base64'),
      )
    }
  report.checks.push({ name: 'S5 完整应用两个图标入口位置和快捷键提示；六种外观标题高亮截图' })
}
