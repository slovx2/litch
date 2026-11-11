// 无头浏览器只用模拟核心，结束关闭浏览器和 Vite，不保存截图。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { checkBoardMemory, checkMobileBoardMemory } from './check-board-memory.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { installManagerBoardMobileFixture } from './manager-board-mobile-fixture.mjs'

const repo = resolve(import.meta.dirname, '..')
/** 页面 localStorage 里经理答复草稿那一项 */
const answerDrafts = (dump) =>
  Object.entries(JSON.parse(dump)).find(([key]) => key.startsWith('litch.manager.answers:'))?.[1] ??
  '{}'
const root = mkdtempSync(join(tmpdir(), 'console-cards-'))
const mobile = process.argv.includes('--mobile')
const mobileUi = mobile
  ? await installManagerBoardMobileFixture({ consoleCards: true, drafts: true })
  : null
const server = mobile
  ? null
  : spawn(
      process.execPath,
      [
        join(repo, 'packages/ui/node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        '5297',
        '--strictPort',
      ],
      { cwd: join(repo, 'packages/ui'), stdio: 'ignore' },
    )
let browser, cdp
try {
  await until(async () => {
    try {
      return (await fetch(mobileUi?.url ?? 'http://127.0.0.1:5297')).ok
    } catch {
      return false
    }
  }, 'Vite')
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
  assert.ok(binary)
  browser = spawn(
    binary,
    withChromiumTestArgs([
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--no-first-run',
      'about:blank',
    ]),
    {
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let output = ''
  browser.stderr.on('data', (chunk) => (output += chunk))
  cdp = await Cdp.connect(
    await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const r = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  await call('Page.enable')
  await call('Page.navigate', {
    url: mobileUi
      ? `${mobileUi.url}/?app=1&scene=manager-console&lang=zh-CN&skin=standard`
      : 'http://127.0.0.1:5297/test/console-cards-fixture.html?lang=zh-CN',
  })
  const wait = (s) => until(() => read(`!!document.querySelector(${JSON.stringify(s)})`), s, 30000)
  const click = async (s) => {
    await wait(s)
    await read(`document.querySelector(${JSON.stringify(s)}).click()`)
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  }
  if (mobile) {
    // 决策页：卡头草稿标记、底部批量提交条（360×640）
    await call('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 640,
      deviceScaleFactor: 1,
      mobile: true,
    })
    const pause = (ms) => new Promise((r) => setTimeout(r, ms))
    const text = (id) =>
      read(`document.querySelector('[data-testid="${id}"]')?.textContent ?? null`)
    await wait('[data-testid="draft-bar"]')
    assert.equal(await text('draft-summary:D-2'), '✎ 选了「先发，补验放下一版」 · 写了追问')
    assert.equal(await text('draft-summary:D-3'), '✎ 写了说明')
    assert.equal(await text('draft-summary:D-5'), '✎ 写了追问')
    assert.equal(await text('draft-summary:D-1'), null)
    assert.match(await text('draft-bar'), /3 项草稿 ↓ · 1 项失效/)
    // 提交条在滚动区下面贴底，不压在卡片上
    const layout = await read(
      `(()=>{const bar=document.querySelector('[data-testid="draft-bar"]').getBoundingClientRect();const list=document.querySelector('[data-testid="manager-board-scroll"]').getBoundingClientRect();return {bottom:Math.round(innerHeight-bar.bottom),seam:Math.round(bar.top-list.bottom)}})()`,
    )
    assert.deepEqual(layout, { bottom: 0, seam: 0 })
    const scroller = `(e=>e.scrollHeight>e.clientHeight+5?e:[...e.querySelectorAll('div')].find(d=>d.scrollHeight>d.clientHeight+5))(document.querySelector('[data-testid="manager-board-scroll"]'))`
    const located = []
    for (let i = 0; i < 4; i++) {
      await click('[data-testid="draft-bar-locate"]')
      await pause(600)
      located.push(await read(`Math.round(${scroller}.scrollTop)`))
    }
    assert.ok(located[1] > located[0] && located[3] === located[0], `依次定位 ${located}`)
    await click('[data-testid="paging-filter:answered"]')
    await wait('[data-testid="draft-pill:ended"]')
    assert.equal(
      await read(
        `getComputedStyle(document.querySelector('[data-testid="draft-summary:D-7"]')).textDecorationLine`,
      ),
      'line-through',
    )
    await click('[data-testid="paging-filter:open"]')
    await wait('[data-testid="paging-object:D-1"]')
    // 先点开 D-3：批量交掉后，展开的卡里也清空
    await click('[data-testid="paging-object:D-3"]')
    await wait('[data-testid="manager-issue:D-3"] textarea')
    await click('[data-testid="draft-bar-submit"]')
    await wait('[data-testid="draft-bar-sent"]')
    assert.match(await text('draft-bar-sent'), /已提交 3 项/)
    const submitted = await read(
      "window.__managerBoardFixture.calls.find(c=>c.name==='managers.feedback.submit').params",
    )
    assert.deepEqual(
      submitted.answers.map((a) => [a.decisionId, a.optionId, a.text]),
      [
        ['D-2', 'b', ''],
        ['D-3', null, '两个都算，但侧栏分开显示'],
      ],
    )
    assert.deepEqual(
      submitted.questions.map((q) => q.decisionId),
      ['D-2', 'D-5'],
    )
    assert.equal(
      await read(`document.querySelector('[data-testid="manager-issue:D-3"] textarea').value`),
      '',
    )
    await until(
      () => read(`!document.querySelector('[data-testid="draft-bar-sent"]')`),
      '已提交收起',
    )
    assert.equal(await read(`!!document.querySelector('[data-testid="draft-bar"]')`), false)
    // 新选一项又出条；清除先确认
    await click('[data-testid="decision-choice:D-3:a"]')
    await wait('[data-testid="draft-bar"]')
    assert.match(await text('draft-bar'), /1 项草稿/)
    await click('[data-testid="draft-bar-clear"]')
    await click('[data-testid="draft-bar-clear-confirm"]')
    assert.equal(await read(`!!document.querySelector('[data-testid="draft-bar"]')`), false)
    assert.equal(
      await read(
        `document.querySelector('[data-testid="decision-choice:D-3:a"]').getAttribute('aria-checked')`,
      ),
      'false',
    )
    await click('[data-testid="paging-object:D-3"]')
    // “下一个”：答了 D-1 后出条，点了依次展开 D-2…D-6，卡头停在滚动区顶部（留 8），最后一个后置灰
    await click('[data-testid="paging-object:D-1"]')
    await click('[data-testid="decision-choice:D-1:a"]')
    await wait('[data-testid="draft-bar-next"]')
    const openedCard = () =>
      read(`(()=>{const host=document.querySelector('[data-testid="manager-board-scroll"]').getBoundingClientRect();
        const head=[...document.querySelectorAll('[data-testid^="paging-object:"]')].find(e=>e.getAttribute('aria-expanded')==='true');
        return head?{id:head.dataset.testid.slice('paging-object:'.length),top:Math.round(head.getBoundingClientRect().top-host.top)}:null})()`)
    for (const expected of ['D-2', 'D-3', 'D-4', 'D-5', 'D-6']) {
      await click('[data-testid="draft-bar-next"]')
      await until(async () => {
        const now = await openedCard()
        return now?.id === expected && Math.abs(now.top - 8) <= 2
      }, `手机下一个展开 ${expected} 并停在顶部`)
    }
    assert.equal(
      await read(
        `document.querySelector('[data-testid="draft-bar-next"]').getAttribute('aria-disabled')`,
      ),
      'true',
      '手机后面没有待答的决策时“下一个”置灰',
    )
    await click('[data-testid="draft-bar-clear"]')
    await click('[data-testid="draft-bar-clear-confirm"]')
    await click('[data-testid="paging-object:D-6"]')
    await call('Emulation.clearDeviceMetricsOverride')
    console.log('手机决策页：草稿标记、提交条贴底、定位、批量提交、清除确认通过')
    await click('[data-testid="manager-category:request"]')
    await wait('[data-testid="paging-object:R-2"]')
    const selector = '[data-testid="paging-object:R-2"]'
    const top = await read(`document.querySelector('${selector}').getBoundingClientRect().top`)
    await click(selector)
    await wait('[data-testid="manager-issue:R-2"]')
    assert.equal(
      await read(
        `document.querySelector('${selector}').parentElement.contains(document.querySelector('[data-testid="manager-issue:R-2"]'))`,
      ),
      true,
    )
    assert.ok(
      Math.abs(
        top - (await read(`document.querySelector('${selector}').getBoundingClientRect().top`)),
      ) < 2,
    )
    await click('[data-testid="relations:R-2"]')
    await wait('[data-testid="relation:/outside/STORE.md"]')
    assert.equal(
      await read(`document.querySelectorAll('[data-testid="relation:/outside/STORE.md"]').length`),
      1,
    )
    await click('[data-testid="manager-issue:R-2"] textarea')
    assert.equal(await read(`!!document.querySelector('[data-testid="manager-issue:R-2"]')`), true)
    for (const [path, expected] of [
      ['/outside/STORE.md', '隔离文件预览'],
      ['/outside/folder', 'STORE.md'],
      ['/missing', '文件或目录不存在'],
      ['/offline', '设备未连接'],
    ]) {
      await click(`[data-testid="relation:${path}"]`)
      await wait('[data-testid="files"]')
      await until(
        () =>
          read(
            `document.querySelector('[data-testid="files"]').textContent.includes(${JSON.stringify(expected)})`,
          ),
        expected,
      )
      await click('[data-testid="files"] [data-testid="header:back"]')
      await wait('[data-testid="relation:/outside/STORE.md"]')
    }
    await click(selector)
    assert.equal(await read(`!!document.querySelector('[data-testid="manager-issue:R-2"]')`), false)
    console.log('手机正式页面：原位展开、卡头位置、内部控件、链接单处显示通过')
    await checkMobileBoardMemory({ read, click })
  } else {
    await wait('[data-paging-object="R-2"]')
    const before = await read(
      `document.querySelector('[data-paging-object="R-2"]').getBoundingClientRect().top`,
    )
    await click('[data-paging-object="R-2"] button')
    await wait('[data-manager-request="R-2"]')
    const observed = await read(
      `(()=>{const card=document.querySelector('[data-manager-request="R-2"]');return {inline:!!card.closest('[data-paging-object="R-2"]'),headerY:document.querySelector('[data-paging-object="R-2"]').getBoundingClientRect().top,order:[...document.querySelectorAll('[data-paging-object]')].map(e=>e.dataset.pagingObject),links:[...card.querySelectorAll('[title="/outside/STORE.md"], [data-relation-target="/outside/STORE.md"]')].length}})()`,
    )
    console.log(JSON.stringify({ before, ...observed }))
    if (!process.argv.includes('--reproduce')) {
      assert.equal(observed.inline, true)
      assert.ok(Math.abs(before - observed.headerY) < 2, '展开保持卡头位置')
      assert.deepEqual(observed.order, ['R-1', 'R-2', 'R-3'])
      assert.equal(observed.links, 1, '同一链接只显示一次')
      await click('[data-manager-request="R-2"] textarea')
      assert.equal(
        await read(
          `document.querySelector('[data-paging-object="R-2"] button').getAttribute('aria-expanded')`,
        ),
        'true',
      )
      await click('[data-relation-target="/outside/STORE.md"]')
      assert.equal(await read('window.__consoleCards.file().active'), '/outside/STORE.md')
      await click('[data-relation-target="/outside/folder"]')
      assert.equal(await read('window.__consoleCards.file().revealDirectory'), true)
      for (const [path, message] of [
        ['/missing', '文件或目录不存在'],
        ['/offline', '设备未连接'],
      ]) {
        await click(`[data-relation-target="${path}"]`)
        await until(
          () => read(`document.body.textContent.includes(${JSON.stringify(message)})`),
          message,
        )
        await click('.file-link-dialog .modal-foot button')
      }
      for (const path of ['main', 'abc123']) {
        await click(`[data-relation-target="${path}"]`)
        await wait('.mg-reference-preview')
        await click('.mg-reference-preview button')
      }
      for (const path of ['D-15', 'I-2']) await click(`[data-relation-target="${path}"]`)
      await click('[data-relation-target="manager-k1"]')
      assert.deepEqual(await read('window.__consoleCards.opened'), ['D-15', 'I-2', 'manager-k1'])
      await click('[data-relation-target="https://example.com"] a')
      assert.equal(await read('window.__consoleCards.opened.at(-1)'), 'https://example.com')
      await click('[data-paging-object="R-2"] > button')
      assert.equal(await read('!!document.querySelector("[data-paging-detail]")'), false)
      await read(`document.querySelector('[data-paging-object="R-2"] > button').focus()`)
      for (const [key, code, keyCode] of [
        ['Enter', 'Enter', 13],
        [' ', 'Space', 32],
      ]) {
        await call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: key === 'Enter' ? '\r' : ' ',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        })
        await call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        })
        await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      }
      assert.equal(
        await read('!!document.querySelector("[data-paging-detail]")'),
        false,
        'Enter 展开、空格收起',
      )
      console.log('控制台原地展开、内部控件、文件/目录/失败提示、Git/看板链接、单处显示通过')
      // 决策页：收起卡头的草稿标记、固定在列表底部的提交条、批量提交、清除、待确认
      const decisions = (drafts) =>
        `http://127.0.0.1:5297/test/console-cards-fixture.html?lang=zh-CN&tab=decisions&height=500&drafts=${drafts}`
      const frame = () =>
        read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      const bar = () =>
        read(`(()=>{const body=document.querySelector('.mg-body').getBoundingClientRect();const bars=document.querySelectorAll('.mg-send');const bar=bars[0];const b=bar?.getBoundingClientRect();
          const cards=[...document.querySelectorAll('[data-paging-object]')];const loaded=[...document.querySelectorAll('[data-manager-paging] > p')].at(-1);
          return {count:bars.length,inCard:!!bar?.closest('[data-paging-object]'),gap:b?Math.round(body.bottom-b.bottom):null,text:bar?.textContent??'',
            lastCard:b?Math.round(b.top-cards.at(-1).getBoundingClientRect().bottom):null,loaded:b&&loaded?Math.round(b.top-loaded.getBoundingClientRect().bottom):null}})()`)
      const pinned = async (label) => {
        const found = await bar()
        assert.equal(found.count, 1, `${label}：只有一条提交条`)
        assert.equal(found.inCard, false, `${label}：提交条不在卡片里`)
        assert.ok(Math.abs(found.gap) <= 1, `${label}：提交条贴着列表底部 ${found.gap}`)
        return found
      }
      const marks = () =>
        read(
          `Object.fromEntries([...document.querySelectorAll('[data-paging-object]')].map(e=>[e.dataset.pagingObject,[e.dataset.draftMark??'',e.querySelector('[data-draft-summary]')?.textContent.trim()??'',e.querySelector('[data-draft-pill]')?.dataset.draftPill??'']]))`,
        )
      await call('Page.navigate', { url: decisions('1') })
      await wait('[data-paging-object="D-1"]')
      await wait('.mg-send')
      assert.deepEqual(await marks(), {
        'D-1': ['', '', ''],
        'D-2': ['live', '✎ 选了「先发，补验放下一版」 · 写了追问', 'live'],
        'D-3': ['live', '✎ 写了说明', 'live'],
        'D-4': ['', '', ''],
        'D-5': ['live', '✎ 写了追问', 'live'],
        'D-6': ['', '', ''],
      })
      // 都没点开过：草稿照样计数；失效的单独写
      const collapsed = await pinned('全部收起')
      assert.match(collapsed.text, /3 项草稿，尚未提交/)
      assert.match(collapsed.text, /1 项已失效，不会提交/)
      // 依次定位有草稿的卡，末尾滚不到顶的也会往下走，到底回到第一张
      const located = []
      for (let i = 0; i < 4; i++) {
        await click('[data-act="manager-locate-draft"]')
        located.push(await read('document.activeElement?.dataset.pagingObject ?? null'))
      }
      assert.deepEqual(located, ['D-2', 'D-3', 'D-5', 'D-2'])
      await read("document.querySelector('.mg-body').scrollTop=0")
      await click('[data-paging-object="D-2"] > button')
      await wait('[data-decision="D-2"]')
      // 展开有 200 毫秒的高度过渡：等它走完再量滚到底
      await until(() => read('document.getAnimations().length === 0'), '展开过渡结束')
      assert.equal(
        await read('!!document.querySelector("[data-paging-history]")'),
        false,
        '没改过的决策不出旧版本按钮',
      )
      for (const where of ['0', 'host.scrollHeight / 2', 'host.scrollHeight']) {
        await read(
          `(()=>{const host=document.querySelector('.mg-body');host.scrollTop=${where}})()`,
        )
        await frame()
        await pinned(`展开 D-2，滚到 ${where}`)
      }
      const bottom = await pinned('滚到底')
      assert.ok(
        bottom.lastCard >= 0 && bottom.loaded >= 0,
        `最后一张卡不被挡住 ${JSON.stringify(bottom)}`,
      )
      // 内容不满一屏的分栏：提交条照样在底部；失效草稿标在卡头、摘要划掉
      await click('[data-paging-filter="answered"]')
      await wait('[data-paging-object="D-7"]')
      assert.deepEqual((await marks())['D-7'], ['ended', '✎ 选了「照推荐做」', 'ended'])
      await pinned('已答复（不满一屏）')
      await click('[data-paging-filter="open"]')
      await wait('[data-paging-object="D-1"]')
      // 批量提交：没点开过的 D-3、D-5 一起交，失效的 D-7 不交
      await read('window.__consoleCards.calls.length = 0')
      await click('[data-act="manager-submit"]')
      await wait('.mg-send[data-sent]')
      assert.match(await read("document.querySelector('.mg-send').textContent"), /已提交 3 项/)
      const submitted = await read(
        "window.__consoleCards.calls.find(c=>c.name==='managers.feedback.submit').params",
      )
      assert.deepEqual(
        submitted.answers.map((a) => [a.decisionId, a.optionId, a.text]),
        [
          ['D-2', 'b', ''],
          ['D-3', null, '两个都算，但侧栏分开显示'],
        ],
      )
      assert.deepEqual(
        submitted.questions.map((q) => q.decisionId),
        ['D-2', 'D-5'],
      )
      assert.deepEqual(
        Object.keys(JSON.parse(answerDrafts(await read('JSON.stringify(localStorage)')))),
        ['D-7'],
        '交掉的清掉，失效的留着',
      )
      await until(() => read("!document.querySelector('.mg-send')"), '已提交提示收起', 10000)
      assert.deepEqual(
        Object.values(await marks()).filter(([mark]) => mark),
        [],
      )
      // 清除草稿
      await call('Page.navigate', { url: decisions('1') })
      await wait('.mg-send')
      await click('.mg-send .btn.ghost')
      assert.equal(await read("!!document.querySelector('.mg-send')"), false)
      assert.equal(await read("document.querySelectorAll('[data-draft-mark]').length"), 0)
      // 待确认：卡头标出，提交按钮禁用并写明原因
      await call('Page.navigate', { url: decisions('conflict') })
      await wait('[data-draft-pill="conflict"]')
      assert.deepEqual((await marks())['D-4'], ['conflict', '✎ 写了说明', 'conflict'])
      assert.deepEqual(
        await read(
          '(()=>{const b=document.querySelector(\'[data-act="manager-submit"]\');return [b.disabled,b.title]})()',
        ),
        [true, '决策已更新，请核对最新内容后重新确认答复'],
      )
      console.log(
        '决策页：收起草稿标记、提交条固定与不遮挡、定位、批量提交、清除、失效与待确认通过',
      )
      // 整卡点击与过渡：点收起卡的空白处展开、选着文字时不展开；展开下面那张时上面那张收起，被点的卡逐帧留在原处；
      // 提交后离开的卡收拢、下面的卡补到老位置；偏好减少动态时不做过渡，被点的卡照样留在原处
      await read('localStorage.clear()')
      await call('Page.navigate', {
        url: 'http://127.0.0.1:5297/test/console-cards-fixture.html?lang=zh-CN&tab=decisions&height=500&settle=1',
      })
      await wait('[data-paging-object="D-1"]')
      const expanded = (id) =>
        read(
          `document.querySelector('[data-paging-object="${id}"] > button').getAttribute('aria-expanded')`,
        )
      await read(
        `(()=>{const p=document.querySelector('[data-paging-object="D-4"] .mg-paging-preview');const r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);p.click();getSelection().removeAllRanges()})()`,
      )
      await frame()
      assert.equal(await expanded('D-4'), 'false', '选着文字点击不展开')
      await click('[data-paging-object="D-1"] .mg-paging-preview')
      await wait('[data-decision="D-1"]')
      assert.equal(await expanded('D-1'), 'true', '点卡片空白处展开')
      await read('new Promise(r=>setTimeout(r,400))')
      /** 点 id 那张卡的空白处，逐帧记它的纵坐标（排在过渡的补偿之后读），结束后再读一次 */
      const track = (id, frames = 14) =>
        read(`new Promise(done=>{const host=document.querySelector('.mg-body');const card=()=>document.querySelector('[data-paging-object="${id}"]');const list=card().parentElement;const top=()=>card().getBoundingClientRect().top;const rel=()=>top()-list.getBoundingClientRect().top;
          const before=top();card().querySelector('.mg-paging-preview').click();
          setTimeout(()=>{const anims=document.getAnimations().length;const tops=[];let n=0;const tick=()=>{tops.push(Math.round(top()-before));if(++n<${frames})requestAnimationFrame(tick);else setTimeout(()=>done({anims,tops,after:Math.round(top()-before),rel:rel(),scroll:host.scrollTop}),350)};requestAnimationFrame(tick)},0)})`)
      await read(
        `(()=>{const host=document.querySelector('.mg-body');const card=document.querySelector('[data-paging-object="D-3"]');host.scrollTop+=card.getBoundingClientRect().top-host.getBoundingClientRect().top-150})()`,
      )
      await frame()
      const held = await track('D-3')
      assert.ok(held.anims > 0, `展开时做过渡 ${JSON.stringify(held)}`)
      assert.ok(
        held.tops.every((dy) => Math.abs(dy) < 2) && Math.abs(held.after) < 2,
        `被点的卡留在原处 ${JSON.stringify(held)}`,
      )
      assert.equal(await expanded('D-1'), 'false')
      // 提交 D-3：离开待定后原处收拢，D-4 补到 D-3 的老位置
      await click('[data-decision="D-3"] .mg-option input')
      await wait('.mg-send')
      const place = await read(
        `(()=>{const list=document.querySelector('[data-paging-object="D-3"]').parentElement.getBoundingClientRect().top;return {d3:document.querySelector('[data-paging-object="D-3"]').getBoundingClientRect().top-list,d4:document.querySelector('[data-paging-object="D-4"]').getBoundingClientRect().top-list}})()`,
      )
      await click('[data-act="manager-submit"]')
      await until(
        () => read(`!document.querySelector('[data-paging-object="D-3"]')`),
        'D-3 离开待定',
      )
      const leaving = await read(
        `(()=>{const ghost=document.querySelector('[data-motion-ghost]');const list=document.querySelector('[data-paging-object="D-4"]').parentElement;return {ghost:!!ghost&&ghost.inert&&ghost.getAttribute('aria-hidden')==='true',d4:document.querySelector('[data-paging-object="D-4"]').getBoundingClientRect().top-list.getBoundingClientRect().top}})()`,
      )
      await read('new Promise(r=>setTimeout(r,450))')
      const filled = await read(
        `(()=>{const list=document.querySelector('[data-paging-object="D-4"]').parentElement;return {d4:document.querySelector('[data-paging-object="D-4"]').getBoundingClientRect().top-list.getBoundingClientRect().top,ghosts:document.querySelectorAll('[data-motion-ghost]').length}})()`,
      )
      assert.ok(leaving.ghost, '离开的卡原处收拢、不可交互、读屏跳过')
      assert.ok(
        leaving.d4 > place.d3 + 2,
        `收拢开始时 D-4 还在下方 ${JSON.stringify({ place, leaving })}`,
      )
      assert.ok(
        Math.abs(filled.d4 - place.d3) < 2 && filled.ghosts === 0,
        `D-4 补到老位置、不留残影 ${JSON.stringify({ place, filled })}`,
      )
      // 偏好减少动态：不做过渡，被点的卡照样留在原处
      await call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })
      await read(
        `(()=>{const host=document.querySelector('.mg-body');const card=document.querySelector('[data-paging-object="D-5"]');host.scrollTop+=card.getBoundingClientRect().top-host.getBoundingClientRect().top-150})()`,
      )
      await frame()
      const still = await track('D-5', 4)
      assert.equal(still.anims, 0, `减少动态时不做过渡 ${JSON.stringify(still)}`)
      assert.ok(
        still.tops.every((dy) => Math.abs(dy) < 2) && Math.abs(still.after) < 2,
        `减少动态时被点的卡也留在原处 ${JSON.stringify(still)}`,
      )
      await call('Emulation.setEmulatedMedia', { features: [] })
      console.log('整卡点击、展开时被点的卡留在原处、提交后收拢补位、减少动态通过')
      // 提交条上的“下一个”：展开下一个待答且没草稿的决策，卡头停在列表顶部（留 8px）；后面没有了置灰
      await call('Page.navigate', { url: decisions('1') })
      await wait('[data-act="manager-next-decision"]')
      const nextButton = () =>
        read(
          `(()=>{const b=document.querySelector('[data-act="manager-next-decision"]');return {disabled:b.disabled,title:b.title,text:b.textContent.trim()}})()`,
        )
      const opened = () =>
        read(
          `(()=>{const host=document.querySelector('.mg-body');const card=document.querySelector('.mg-paging-head[aria-expanded="true"]')?.closest('[data-paging-object]');
            return card?{id:card.dataset.pagingObject,top:Math.round(card.getBoundingClientRect().top-host.getBoundingClientRect().top)}:null})()`,
        )
      assert.deepEqual(await nextButton(), {
        disabled: false,
        title: '展开下一个待答的决策',
        text: '下一个 ↓',
      })
      const steps = []
      for (const expected of ['D-1', 'D-4', 'D-6']) {
        await click('[data-act="manager-next-decision"]')
        const at = await until(async () => {
          const now = await opened()
          return now?.id === expected && Math.abs(now.top - 8) <= 1 ? now : null
        }, `下一个展开 ${expected} 并停在顶部`)
        steps.push(at.id)
      }
      // 有草稿的 D-2、D-3、D-5 跳过
      assert.deepEqual(steps, ['D-1', 'D-4', 'D-6'])
      assert.deepEqual(await nextButton(), {
        disabled: true,
        title: '后面没有待答的决策了',
        text: '下一个 ↓',
      })
      // 键盘：聚焦后按 Enter 与点击相同；减少动态时直接定位，不做平滑滚动
      await call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })
      await click('[data-paging-object="D-1"] .mg-paging-head')
      await until(async () => (await opened())?.id === 'D-1', '回到 D-1')
      await read(`document.querySelector('[data-act="manager-next-decision"]').focus()`)
      await call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      })
      await call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      await frame()
      const instant = await opened()
      assert.ok(
        instant?.id === 'D-4' && Math.abs(instant.top - 8) <= 1,
        `减少动态时一步定位 ${JSON.stringify(instant)}`,
      )
      await call('Emulation.setEmulatedMedia', { features: [] })
      console.log('下一个：跳过草稿、停在顶部、末尾置灰、键盘与减少动态通过')
    }
  }
  if (!mobile) await checkBoardMemory({ call, read, click })
} finally {
  cdp?.close()
  for (const child of [browser, server])
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise((r) => child.once('exit', r))
    }
  await mobileUi?.close()
  rmSync(root, { recursive: true, force: true })
}
