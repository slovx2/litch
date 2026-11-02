// 对着模拟核心的集中建议验收。先起 UI 开发服务器；浏览器无头、用户目录隔离，退出关闭。
// node scripts/check-suggestion-inbox.mjs [http://127.0.0.1:5289]
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url = process.argv[2] ?? 'http://127.0.0.1:5289'
const binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  )
    .sort()
    .at(-1)
if (!binary) throw new Error('需要 LITCH_CHROME_BINARY 指向 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-suggestions-'))
const output = process.env.LITCH_SUGGESTION_SHOTS ?? join(process.cwd(), '.local/suggestion-inbox')
mkdirSync(output, { recursive: true })
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  {
    env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let endpoint = ''
child.stderr.on('data', (chunk) => {
  endpoint += String(chunk)
})
let cdp
try {
  const ws = await until(
    () => endpoint.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    '隔离浏览器',
  )
  assert.ok(
    execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'args='], {
      encoding: 'utf8',
    }).includes(`--user-data-dir=${work}/profile`),
  )
  cdp = await Cdp.connect(ws)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector)
  const click = async (selector) => {
    if (
      /data-board-tab=.[a-z]/.test(selector) &&
      !(await read(`!!document.querySelector(${JSON.stringify(selector)})`))
    ) {
      await read("document.querySelector('[data-board-tab=inbox]')?.click()")
      await new Promise((r) => setTimeout(r, 100))
    }
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await new Promise((r) => setTimeout(r, 180))
  }
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `M9-${name}.png`), Buffer.from(picture.data, 'base64'))
  }
  const say = async (text) => {
    await wait('.main .dock textarea.cmp-text')
    await read(
      `(()=>{const e=document.querySelector('.main .dock textarea.cmp-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    )
    await new Promise((r) => setTimeout(r, 100))
    await read(
      `document.querySelector('.main .dock textarea.cmp-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    )
    await wait('.wrap-cards [data-card="proposal"]')
    await until(() => read("!document.querySelector('.main .running-line')"), '回合结束')
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  await wait('.sb-btn.suggestions')
  await read("document.querySelector('.onb .ibtn')?.click()")
  await read("window.__litchLook.set({skin:'standard',theme:'light',lang:'zh-CN'})")
  await click(
    '.row-line[data-session="s6"]:not(.projection-group *) .ss-row:not(.projection-group *)',
  )
  await say('收尾建议')
  await click('.sb-btn.suggestions')
  await wait('.suggestion-row')
  assert.equal(await read("document.querySelectorAll('.suggestion-row').length"), 2)
  await shot('suggestions-zh')
  await read("window.__litchLook.set({lang:'en'})")
  await shot('suggestions-en')
  await click('.suggestion-row [data-act="edit"]')
  await wait('.spawn-dialog')
  await read(
    "document.querySelector('.spawn-dialog').close();document.querySelector('.spawn-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))",
  )
  // 关闭编辑后忽略一张，列表与角标都应随之减少。
  await click('.suggestion-row [data-act="dismiss"]')
  await until(() => read("document.querySelectorAll('.suggestion-row').length === 1"), '忽略移除')
  await read("window.__litchLook.set({lang:'zh-CN'})")
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await click('[data-board-tab="inbox"]')
  assert.ok(
    await read(
      "document.querySelector('[data-manager-id=\"m1\"] .mg-pick small').textContent.includes('4')",
    ),
    '侧栏合计待定决策与待做请求',
  )
  assert.equal(
    await read("document.querySelector('.mg-sidebar-counts [title]').title"),
    '3 个决策 · 1 个请你做',
  )
  assert.equal(
    await read("document.querySelector('.mg-sidebar-counts [title]').textContent"),
    '4 待处理',
  )
  await shot('manager-entry')
  await click('[data-board-tab="reports"]')
  assert.equal(await read("document.querySelector('.mg-board').getBoundingClientRect().width"), 560)
  await until(
    () =>
      read(
        "document.querySelector('[data-relations=P-1]').dataset.wide==='true' && getComputedStyle(document.querySelector('[data-relations=P-1]')).float==='right'",
      ),
    '1440 默认 560 看板关联靠右',
  )
  await shot('report-default-1440')

  await click('[data-board-tab="suggestions"]')
  assert.equal(await read("document.querySelectorAll('.suggestion-row').length"), 0)
  // 从经理的工作线产生建议，全局只留一张经理汇总卡；打开后在看板内操作。
  // 经理行默认收起，下面一行“› N 个子会话”：先展开
  await read(
    "document.querySelectorAll('.mg-sidebar-manager .tree-kids > .tree-sum').forEach((sum) => sum.click())",
  )
  await click(
    '[data-session="manager-k2"]:not(.projection-group *) .ss-row:not(.projection-group *)',
  )
  await say('收尾建议')
  await click('[data-session="manager-k2"]:not(.projection-group *) [aria-haspopup="menu"]')
  await click('[data-action="archive"]')
  await click('.sb-btn.suggestions')
  await wait('[data-suggestion-manager="m1"]')
  assert.equal(
    await read('document.querySelectorAll(\'[data-page="suggestions"] .suggestion-row\').length'),
    1,
  )
  assert.equal(await read("document.querySelectorAll('[data-suggestion-manager]').length"), 1)
  await shot('manager-summary')
  await click('[data-suggestion-manager="m1"] button')
  await wait('.mg-board .suggestion-row')
  assert.equal(
    await read(
      "document.querySelector('[data-board-tab=\"suggestions\"]').getAttribute('aria-pressed')",
    ),
    'true',
  )
  assert.equal(await read("document.querySelectorAll('.mg-board .suggestion-row').length"), 2)
  assert.equal(await read("document.querySelector('[data-suggestions-unreviewed]').open"), false)
  assert.equal(
    await read('document.querySelector(\'[data-board-tab="suggestions"] .pill\') === null'),
    true,
  )
  await click('[data-suggestions-unreviewed] > summary')

  await click('.mg-board .suggestion-row [data-act="open-source"]')
  await wait('.arch-bar')
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  })
  await wait('.mg-board .suggestion-row')
  assert.equal(
    await read(
      "document.querySelector('[data-board-tab=\"suggestions\"]').getAttribute('aria-pressed')",
    ),
    'true',
    '归档预览返回建议页签',
  )
  await click('[data-suggestions-unreviewed] > summary')
  await click('.mg-board .suggestion-row [data-act="edit"]')
  await wait('.spawn-dialog')
  await read(
    "document.querySelector('.spawn-dialog').close();document.querySelector('.spawn-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))",
  )
  await click('.mg-board .suggestion-row [data-act="dismiss"]')
  await until(
    () => read("document.querySelectorAll('.mg-board .suggestion-row').length === 1"),
    '看板忽略建议',
  )
  await shot('manager-suggestions')
  await say('收尾建议')
  await until(
    () => read("document.querySelectorAll('.mg-board .suggestion-row').length === 3"),
    '经理自己的建议默认审核',
  )
  assert.equal(
    await read('document.querySelector(\'[data-board-tab="suggestions"] .pill\').textContent'),
    '2',
  )
  for (const skin of ['standard', 'human', 'retro']) {
    await read(`window.__litchLook.set({skin:${JSON.stringify(skin)}})`)
    await read("document.querySelector('[data-suggestions-unreviewed]').open=false")
    await shot(`review-collapsed-${skin}`)
    await click('[data-suggestions-unreviewed] > summary')
    await shot(`review-expanded-${skin}`)
  }
  await click('.sb-btn.suggestions')
  await wait('[data-suggestion-manager="m1"]')
  assert.equal(
    await read(
      'document.querySelector(\'[data-suggestion-manager="m1"] header .pill:nth-of-type(2)\').textContent',
    ),
    '2 条建议',
  )
  await shot('manager-reviewed-summary')
  await click('[data-suggestion-manager="m1"] button')

  // 事项与决策共享正式 Markdown，编号、列表、代码、外链均从真实渲染节点核对。
  await click('[data-board-tab="items"]')
  assert.ok(
    await read('!!document.querySelector(\'[data-manager-item="I-2"] .mg-item-reason strong\')'),
  )
  assert.ok(
    await read('!!document.querySelector(\'[data-manager-item="I-2"] .mg-item-reason ul code\')'),
  )
  assert.ok(
    await read(
      '!!document.querySelector(\'[data-manager-item="I-3"] .mg-item-unverified strong\')',
    ),
  )
  await click('[data-manager-item="I-2"] .mg-item-reason [data-board-reference="D-15"]')
  assert.ok(await read('!!document.querySelector(\'[data-decision="D-15"] > .mg-markdown li\')'))
  assert.ok(
    await read('!!document.querySelector(\'[data-decision="D-15"] .mg-option .md strong\')'),
  )
  await click('[data-decision="D-15"] > .mg-markdown [data-board-reference="I-1"]')
  assert.equal(await read("document.activeElement?.getAttribute('data-manager-item')"), 'I-1')
  assert.equal(await read("!!document.querySelector('.mg-foot')"), false)

  // 审核回归：整张选项可点，说明关联给读屏，编号链接不能顺带选择选项。
  await click('[data-board-tab="decisions"]')
  await click('[data-decision="D-15"] .mg-option:first-child .mg-markdown')
  assert.equal(
    await read(
      'document.querySelector(\'[data-decision="D-15"] .mg-option:first-child input\').checked',
    ),
    true,
  )
  assert.ok(
    await read(
      "document.querySelector('[data-decision=\"D-15\"] .mg-option:first-child input').getAttribute('aria-describedby')",
    ),
  )
  await click('[data-decision="D-15"] .mg-option:nth-child(2)')
  assert.equal(
    await read(
      'document.querySelector(\'[data-decision="D-15"] .mg-option:nth-child(2) input\').checked',
    ),
    true,
  )
  await click('[data-decision="D-15"] .mg-option:first-child [data-board-reference="I-1"]')
  await click('[data-board-tab="decisions"]')
  assert.equal(
    await read(
      'document.querySelector(\'[data-decision="D-15"] .mg-option:nth-child(2) input\').checked',
    ),
    true,
  )
  await click('[data-decision="D-15"] .mg-decision-meta [data-board-reference="I-2"]')
  assert.equal(await read("document.activeElement?.getAttribute('data-manager-item')"), 'I-2')
  assert.equal(
    await read(
      'getComputedStyle(document.querySelector(\'[data-manager-item="I-3"] .mg-markdown p\')).whiteSpace',
    ),
    'pre-line',
  )
  await read("document.querySelector('.mg-body').scrollTop=500")
  await click('[data-board-tab="overview"]')
  assert.equal(await read("document.querySelector('.mg-body').scrollTop"), 0)
  await click('[data-overview="requests"] [data-board-reference="R-1"]')
  assert.equal(await read("document.activeElement?.getAttribute('data-manager-request')"), 'R-1')
  assert.equal(
    await read('document.querySelector(\'[data-board-tab="requests"] .pill\').textContent'),
    '1',
  )
  assert.ok(
    await read(
      "document.querySelector('[data-board-tab=\"requests\"] .pill').classList.contains('wait')",
    ),
  )
  await click('[data-board-tab="items"]')

  const size = async (width) => {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await new Promise((r) => setTimeout(r, 200))
  }
  const shown = (selector) =>
    read(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0})()`,
    )
  const widthOf = (selector) =>
    read(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width`)
  const noOverflow = async () => {
    assert.ok(
      await read(
        "document.querySelector('.mg-board').scrollWidth <= document.querySelector('.mg-board').clientWidth + 1",
      ),
      '看板横向溢出',
    )
    assert.ok(
      await read(
        "document.querySelector('.mg-page').scrollWidth <= document.querySelector('.mg-page').clientWidth + 1",
      ),
      '主区横向溢出',
    )
  }
  await size(1600)
  const originalWidth = await widthOf('.mg-board')
  const grip = await read(
    "(()=>{const r=document.querySelector('.mg-board-grip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()",
  )
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...grip,
    button: 'left',
    clickCount: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: grip.x - 100,
    y: grip.y,
    button: 'left',
    buttons: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: grip.x - 100,
    y: grip.y,
    button: 'left',
    clickCount: 1,
  })
  await until(async () => (await widthOf('.mg-board')) > originalWidth + 80, '拖动增宽看板')
  const resized = await widthOf('.mg-board')
  await read("document.querySelector('.mg-board-grip').focus()")
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Home',
    code: 'Home',
    windowsVirtualKeyCode: 36,
  })
  await until(async () => Math.abs((await widthOf('.mg-board')) - 360) < 1, '键盘调整到最小宽度')
  await read("window.__litchLook.set({lang:'en'})")
  await noOverflow()
  await shot('board-min-width-en')
  // 切换语言后重新聚焦，并按当前主区可用空间检查宽度上限。
  await read("document.querySelector('.mg-board-grip').focus()")
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
  })
  const maximum = await read(
    "Number(document.querySelector('.mg-board-grip').getAttribute('aria-valuemax'))",
  )
  await until(async () => {
    const actual = await widthOf('.mg-board')
    if (Math.abs(actual - maximum) < 1) return true
    throw new Error(
      JSON.stringify(
        await read(
          `({actual:${actual},maximum:${maximum},focus:document.activeElement?.outerHTML,saved:localStorage.getItem('litch.managerBoardLayout')})`,
        ),
      ),
    )
  }, '键盘调整到最大宽度')
  assert.ok((await widthOf('.mg-chat')) >= 460, '对话保留足够宽度')
  for (const skin of ['standard', 'human', 'retro']) {
    for (const lang of ['zh-CN', 'en']) {
      await read(
        `window.__litchLook.set({skin:${JSON.stringify(skin)},lang:${JSON.stringify(lang)}})`,
      )
      assert.ok(
        await read(
          `Array.from(document.querySelectorAll('.mg-chat .cmp-bar .pick-btn .ell')).every(e=>e.scrollWidth<=e.clientWidth+1)`,
        ),
        '最窄对话的模型、权限按钮保留完整文字',
      )
      await shot(`composer-min-${skin}-${lang}`)
    }
  }

  await noOverflow()
  const restoreGrip = await read(
    "(()=>{const r=document.querySelector('.mg-board-grip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()",
  )
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...restoreGrip,
    button: 'left',
    clickCount: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: restoreGrip.x + maximum - resized,
    y: restoreGrip.y,
    button: 'left',
    buttons: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: restoreGrip.x + maximum - resized,
    y: restoreGrip.y,
    button: 'left',
    clickCount: 1,
  })
  await read("window.__litchLook.set({lang:'zh-CN'})")
  await until(async () => Math.abs((await widthOf('.mg-board')) - resized) < 1, '恢复拖动宽度')
  await click('[data-act="manager-board-toggle"]')
  assert.equal(await shown('.mg-board'), false)
  assert.ok(Math.abs((await widthOf('.mg-chat')) - (await widthOf('.mg-page'))) < 1)
  for (const chatWidth of ['compact', 'wide']) {
    await read(`window.__litchLook.set({chatWidth:${JSON.stringify(chatWidth)}})`)
    await shot(`board-collapsed-${chatWidth}`)
    assert.ok(
      await read(
        "document.querySelector('.mg-chat').scrollWidth <= document.querySelector('.mg-chat').clientWidth + 1",
      ),
    )
  }
  await click('[data-act="manager-board-toggle"]')
  assert.ok(Math.abs((await widthOf('.mg-board')) - resized) < 1)
  await call('Page.reload')
  await wait('.sb-btn.suggestions')
  await read("document.querySelector('.onb .ibtn')?.click()")
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await wait('.mg-board-grip')
  assert.ok(Math.abs((await widthOf('.mg-board')) - resized) < 1, '刷新后保留宽度')
  for (const skin of ['standard', 'human', 'retro']) {
    for (const theme of ['light', 'dark']) {
      await read(
        `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:${JSON.stringify(theme)}})`,
      )
      for (const tab of ['overview', 'items', 'decisions', 'requests', 'reports']) {
        await click(`[data-board-tab="${tab}"]`)
        await noOverflow()
        await shot(`board-${tab}-${skin}-${theme}`)
        if (tab === 'overview') {
          assert.ok(
            await read('document.querySelector(\'[data-activity="activity-0"] strong\') !== null'),
          )
          assert.ok(
            await read(
              "document.querySelector('[data-activity=\"activity-0\"] .mg-activity-source').textContent.includes('工作线')",
            ),
          )
          await read(
            "document.querySelector('[data-activity=\"activity-0\"]').scrollIntoView({block:'center'})",
          )
          await shot(`activity-collapsed-${skin}-${theme}`)
          await click('[data-activity="activity-0"] [data-act="manager-activity-expand"]')
          assert.equal(
            await read(
              'document.querySelector(\'[data-activity="activity-0"] .mg-activity-content\').dataset.expanded',
            ),
            'true',
          )
          await shot(`activity-expanded-${skin}-${theme}`)
        }

        if (['decisions', 'requests', 'reports'].includes(tab)) {
          assert.equal(
            await read(
              "getComputedStyle(document.querySelector('.mg-inbox-tabs [aria-pressed=true] .pill')).color",
            ),
            await read(
              "getComputedStyle(document.querySelector('.mg-inbox-tabs [aria-pressed=true]')).color",
            ),
            '选中计数使用选中前景',
          )
        }
        if (tab === 'decisions') {
          // 帖子讨论在看板底部分屏里：先点卡片标题行的讨论入口
          await click('[data-decision="D-15"] [data-act="post-discussion"]')
          await click('.mg-talk-pane[data-post="D-15"] [data-question-mode="manager"]')
          assert.ok(
            await read("!document.querySelector('.mg-decision-filter').classList.contains('seg')"),
          )
          assert.ok(
            await read(
              "document.querySelector('.mg-talk-pane[data-post=\"D-15\"] .mg-post-compose textarea').placeholder.includes('经理')",
            ),
          )
          await read(
            "document.querySelector('[data-decision=\"D-15\"]').scrollIntoView({block:'start'})",
          )
          await shot(`questions-manager-${skin}-${theme}`)
          await click('.mg-talk-pane[data-post="D-15"] [data-question-mode="temporary"]')
          assert.ok(
            await read(
              "document.querySelector('.mg-talk-pane[data-post=\"D-15\"] .mg-post-compose textarea').placeholder.includes('临时')",
            ),
          )
          await shot(`questions-temporary-${skin}-${theme}`)
          await click('.mg-talk-pane[data-post="D-15"] [data-act="discussion-close"]')
        }
      }
      await click('[data-board-tab="items"]')
      await click('[data-act="manager-board-toggle"]')
      await size(900)
      await click('.mg-narrow button:last-child')
      assert.equal(await shown('.mg-board'), true, '窄窗口不受桌面收起状态影响')
      assert.equal(await shown('.mg-board-grip'), false)
      await noOverflow()
      await shot(`board-narrow-${skin}-${theme}`)
      await click('.mg-narrow button:first-child')
      assert.equal(await shown('.mg-chat'), true)
      assert.equal(await shown('.mg-board'), false)
      await size(1600)
      assert.equal(await shown('.mg-board'), false)
      await click('[data-act="manager-board-toggle"]')
    }
  }
  await click('[data-board-tab="reports"]')
  await wait('[data-report="P-1"]')
  await click('[data-report="P-1"] [data-board-reference="I-2"]')
  assert.equal(await read("document.activeElement?.getAttribute('data-manager-item')"), 'I-2')
  await read("document.querySelector('[data-relations=I-2]').open=true")
  await click('[data-relations="I-2"] [data-relation-target="P-1"]')
  await wait('[data-report="P-1"]')
  await shot('report-reverse-relation')
  await size(1440)
  await read("document.querySelector('.mg-board-grip').focus()")
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Home',
    code: 'Home',
    windowsVirtualKeyCode: 36,
  })
  for (let i = 0; i < 9; i++)
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
    })
  await until(
    () =>
      read(
        "document.querySelector('[data-relations=P-1]').dataset.wide==='true' && getComputedStyle(document.querySelector('[data-relations=P-1]')).float==='right'",
      ),
    '1440 窗口常用宽度关联靠右',
  )
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  })
  await read("document.querySelector('[data-report=P-1] [data-board-reference=D-15]').focus()")
  await wait('.mg-reference-card')
  assert.ok(
    await read(
      "document.querySelector('[data-report=P-1] [data-board-reference=D-15]').getAttribute('aria-describedby') === document.querySelector('.info-card:has(.mg-reference-card)').id",
    ),
  )
  assert.ok(
    await read(
      "document.querySelector('.mg-reference-card').textContent.includes('已答复') || document.querySelector('.mg-reference-card').textContent.includes('待定')",
    ),
  )
  assert.equal(
    await read(
      "document.querySelector('[data-report=P-1] [data-board-reference=D-15]').textContent.trim()",
    ),
    '#D-15',
  )
  await shot('reference-keyboard-preview-1440')
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  })
  await until(() => read("!document.querySelector('.mg-reference-card')"), 'Esc 收起编号预览')

  await size(1800)
  await read("document.querySelector('.mg-board-grip').focus()")
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
  })
  await until(
    () => read("getComputedStyle(document.querySelector('[data-relations=P-1]')).float==='right'"),
    '宽看板关联靠右',
  )
  assert.equal(await read("document.querySelector('[data-relations=P-1]').open"), true)
  await shot('report-wide-relations')
  await click('[data-relations="P-1"] [data-relation-target="manager-k1"]')
  await wait('.mg-origin')
  assert.ok(await read("document.querySelector('.mg-origin').textContent.includes('相关议题')"))
  await click('.mg-origin button')
  await wait('[data-report="P-1"]')
  assert.equal(await read("document.activeElement?.getAttribute('data-report')"), 'P-1')
  await size(1600)

  // 原帖操作与追问同屏、混合提交、单项取消修改，均操作正式界面。
  const fill = async (selector, text) => {
    await read(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    )
    await new Promise((r) => setTimeout(r, 120))
  }
  const question = '.mg-talk-pane[data-post="D-15"] [data-act="manager-question-input"]'
  const questionTab = '[data-decision="D-15"] [data-act="post-discussion"]'
  await click('[data-board-tab="decisions"]')
  if (!(await read(`!!document.querySelector(${JSON.stringify(question)})`)))
    await click(questionTab)
  assert.equal(await read("document.querySelectorAll('[data-decision-tab]').length"), 0)
  await fill(question, '此次修改的依据？')
  assert.ok(
    await read(
      `document.querySelector('[data-decision="D-15"] [data-act="post-discussion"]').hasAttribute('data-unsent')`,
    ),
  )
  await click('[data-board-tab="requests"]')
  await fill('[data-act="manager-request-text"]', '真机复验 **通过**。')
  await click('[data-act="manager-request-deliver"]')
  await click('[data-act="manager-submit"]')
  await wait('[data-act="manager-request-edit"]')
  assert.ok(
    await read("document.querySelector('.mg-request-response strong')?.textContent === '通过'"),
  )
  assert.ok(await read("!!document.querySelector('.mg-request-response time[datetime][title]')"))
  assert.equal(await read('document.querySelector(\'[data-board-tab="requests"] .pill\')'), null)
  assert.ok(
    await read(
      "document.querySelector('[data-manager-id=\"m1\"] .mg-pick small').textContent.includes('2')",
    ),
  )
  await click('[data-board-tab="decisions"]')
  await click('.mg-decision-filter button:nth-child(2)')
  assert.ok(
    await read(
      '!!document.querySelector(\'[data-decision="D-13"] .mg-item-meta-row .mg-item-links li\')',
    ),
    '已落地采用元信息列表',
  )
  assert.ok(
    await read(
      `(()=>{const card=document.querySelector('[data-decision="D-13"]');const answer=card.querySelector('.mg-answer');const edit=card.querySelector('[data-act="manager-edit-answer"]');return !!answer.querySelector('time[datetime][title]')&&!!card.querySelector('footer time[datetime][title]')&&!!(answer.compareDocumentPosition(edit)&Node.DOCUMENT_POSITION_FOLLOWING)})()`,
    ),
  )
  await shot('answered-landed-metadata')
  // 第四轮：已答决策的答复块、收起的其他选项与排序，三皮肤加窄窗口。
  for (const width of [1600, 1000])
    for (const skin of ['standard', 'human', 'retro']) {
      await size(width)
      await read(`window.__litchLook.set({skin:${JSON.stringify(skin)},lang:'zh-CN'})`)
      await wait('[data-decision="D-13"] .mg-answer')
      await read(
        `document.querySelector('[data-decision="D-13"] details[data-other-options]').open=${width === 1000}`,
      )
      await read(`document.querySelector('[data-decision="D-13"]').scrollIntoView({block:'start'})`)
      await shot(`answered-split-${skin}-${width}`)
    }
  await read("window.__litchLook.set({skin:'standard'})")
  await size(1600)
  if (!(await read(`!!document.querySelector(${JSON.stringify(question)})`)))
    await click(questionTab)
  await fill(question, '保留的追问草稿')
  await click('[data-decision="D-15"] [data-act="manager-edit-answer"]')
  await fill('[data-decision="D-15"] [data-act="manager-answer"]', '放弃这次答案修改')
  await click('[data-decision="D-15"] [data-act="manager-cancel-answer-edit"]')
  assert.ok(
    await read(
      `!!document.querySelector('[data-decision="D-15"] [data-act="manager-edit-answer"]')`,
    ),
  )
  if (!(await read(`!!document.querySelector(${JSON.stringify(question)})`)))
    await click(questionTab)
  assert.equal(
    await read(`document.querySelector(${JSON.stringify(question)}).value`),
    '保留的追问草稿',
  )
  assert.ok(
    await read(
      "document.querySelector('.mg-sidebar-counts').textContent.includes('2 待处理') && document.querySelector('.mg-sidebar-counts [data-manager-draft-count]').textContent==='1 项草稿'",
    ),
  )
  await read("window.__litchLook.set({lang:'en'})")
  assert.equal(await read("document.querySelector('.mg-send .grow').textContent"), '1 draft')
  assert.equal(
    await read(
      "document.querySelector('.mg-sidebar-counts [data-manager-draft-count]').textContent",
    ),
    '1 draft',
  )
  await shot('draft-and-attention-en')
  await read("window.__litchLook.set({lang:'zh-CN'})")
  await click('[data-board-tab="requests"]')
  assert.equal(
    await read(
      "document.querySelector('.mg-request-response header').textContent.includes('已交付')",
    ),
    false,
  )
  await click('[data-act="manager-request-edit"]')
  await fill('[data-act="manager-request-text"]', '放弃这次回复修改')
  await click('[data-act="manager-request-cancel-edit"]')
  assert.ok(await read('!document.querySelector(\'[data-act="manager-request-text"]\')'))
  assert.ok(
    await read("document.querySelector('.mg-request-response strong')?.textContent === '通过'"),
  )
  await click('[data-board-tab="decisions"]')
  if (!(await read(`!!document.querySelector(${JSON.stringify(question)})`)))
    await click(questionTab)
  assert.equal(
    await read(`document.querySelector(${JSON.stringify(question)}).value`),
    '保留的追问草稿',
  )
  await click('.mg-talk-pane[data-post="D-15"] [data-question-mode="temporary"]')
  await fill(question, '再确认影响范围')
  await click('.mg-talk-pane[data-post="D-15"] [data-act="post-question-send"]')
  await until(
    () =>
      read(
        "Array.from(document.querySelectorAll('.mg-post-timeline b')).some(e=>e.textContent.startsWith('助手（临时对话）'))",
      ),
    '临时对话标明发言人',
  )
  assert.ok(
    await read("!document.querySelector('[data-decision=D-15] .mg-post-compose')"),
    '追问提交后收起',
  )

  for (const skin of ['standard', 'human', 'retro']) {
    await read(`window.__litchLook.set({skin:${JSON.stringify(skin)},theme:'light',lang:'zh-CN'})`)
    await shot(`question-speakers-${skin}`)
    await click('[data-board-tab="requests"]')
    await shot(`request-response-${skin}`)
    await click('[data-board-tab="decisions"]')
    await size(760)
    await click('.mg-narrow button:last-child')
    await noOverflow()
    await shot(`question-narrow-${skin}`)
    await size(1600)
  }
  await click('[data-act="manager-board-toggle"]')
  assert.equal(
    await read('document.querySelector(\'[data-act="manager-board-toggle"] .pill\').textContent'),
    '2 待处理',
  )
  await click('[data-act="manager-board-toggle"]')
  await read("window.__litchLook.set({skin:'standard',theme:'light',lang:'en'})")
  await click('[data-board-tab="suggestions"]')
  await shot('board-en')
  await read("window.__litchLook.set({lang:'zh-CN'})")
  // 刷新后模拟核心重新开始，在普通会话再生成建议，继续核对来源导航。
  await click('[data-sidebar-mode="chat"]')
  await click(
    '.row-line[data-session="s6"]:not(.projection-group *) .ss-row:not(.projection-group *)',
  )
  await say('收尾建议')
  await click('.sb-btn.suggestions')
  await wait('.suggestion-row')
  // 来源点击沿用会话导航；不能留在集中页面。
  await click('.suggestion-row .prop-meta button')
  await wait(
    '.row-line[data-session="s6"]:not(.projection-group *) .ss-row:not(.projection-group *).sel',
  )
  await click('.sb-settings')
  await click('.set-go[data-page="devices"]')
  await click('.devp-item[data-device="local"] .devp-row')
  const retention = '[data-setting="sessions.suggestionRetentionDays"]'
  await click('[data-sec="group"][data-group="sessions"] .fold')
  await wait(retention)
  await read(
    `document.querySelector(${JSON.stringify(retention)}).scrollIntoView({block:'center'})`,
  )
  assert.deepEqual(
    await read(
      `Array.from(document.querySelector(${JSON.stringify(`${retention} select`)}).options).map(o=>o.value)`,
    ),
    ['1', '3', '7', '14', '30', 'never'],
  )
  await shot('retention')
  console.log(
    '经理看板与集中建议验收通过：汇总卡、Markdown 与编号跳转、已落地元信息、待办计数、单项取消修改、通用追问与报告关联、回复 Markdown 与发言人、最窄输入框、拖动收起/恢复、三皮肤明暗及窄窗口、留存枚举。',
  )
} finally {
  cdp?.close()
  const ended = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await ended
  console.log(`隔离浏览器已关闭，临时目录：${work}`)
}
