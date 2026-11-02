// 手机控制台的正式页面预览；隔离无头浏览器，先运行 mobile preview。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url =
  process.argv[2] ??
  'http://127.0.0.1:5189/?app=1&scene=manager-console&skin=standard&appearance=light&lang=zh-CN'
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
const output =
  process.env.LITCH_SUGGESTION_SHOTS ?? join(process.cwd(), '.artifacts/manager-v4-mobile')
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
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector, 60000)
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `M9-${name}.png`), Buffer.from(picture.data, 'base64'))
  }

  await call('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  await wait('[data-testid="manager-console"]')
  const press = async (text) => {
    await until(
      () =>
        read(
          `(()=>{const button=[...document.querySelectorAll('[role="button"],button')].find(e=>e.getBoundingClientRect().height>0 && e.textContent.trim().replace(/^[▾▸]\\s*/, '')===${JSON.stringify(text)});if(!button)return false;button.click();return true})()`,
        ),
      text,
    )
    await new Promise((r) => setTimeout(r, 150))
  }
  // 页签（下划线式）和类别（小胶囊）带计数，按 testID 点
  const tapId = async (id) => {
    await wait(`[data-testid="${id}"]`)
    await read(`document.querySelector('[data-testid="${id}"]').click()`)
    await new Promise((r) => setTimeout(r, 150))
  }
  const checked = (id) =>
    read(`document.querySelector('[data-testid="${id}"]')?.getAttribute('aria-checked')`)
  // 页签与桌面同序：概览、经理事项、控制台；页签和类别读屏角色不同
  assert.equal(
    await read(
      "[...document.querySelectorAll('[role=tab][data-testid^=\"manager-tab:\"]')].map(e=>e.dataset.testid.slice(12)).join(',')",
    ),
    'overview,items,console',
    '页签顺序',
  )
  await tapId('manager-tab:console')
  assert.equal(await checked('manager-category:decision'), 'true', '类别是单选')
  assert.ok(
    await read(
      '!document.querySelector(\'[data-testid="manager-issue:D-13"] textarea\') && !document.querySelector(\'[data-testid="manager-issue:D-12"] textarea\')',
    ),
  )
  // 排序：默认最新优先，切到最早优先后顺序反过来，再切回。
  const decisionOrder = () =>
    read(
      "[...document.querySelectorAll('[data-testid^=\"manager-issue:D-\"]')].map(e=>e.dataset.testid.slice(14)).join(',')",
    )
  assert.equal(await decisionOrder(), 'D-17,D-16,D-15,D-13,D-12,D-11', '默认最新优先')
  const order = async (key) => {
    await read(`document.querySelector('[data-testid="manager-issue-order"]').click()`)
    await wait(`[data-testid="manager-issue-order:${key}"]`)
    assert.equal(
      await read(
        `document.querySelector('[data-testid="manager-issue-order:${key}"]').getAttribute('role')`,
      ),
      'radio',
      '排序是单选',
    )
    await read(`document.querySelector('[data-testid="manager-issue-order:${key}"]').click()`)
    await new Promise((r) => setTimeout(r, 300))
  }
  await order('oldest')
  assert.equal(await decisionOrder(), 'D-11,D-12,D-13,D-15,D-16,D-17', '最早优先')
  await shot('mobile-order-oldest')
  await order('pending')
  assert.equal(await decisionOrder(), 'D-17,D-16,D-15,D-13,D-12,D-11', '待处理优先')
  await order('newest')
  // 已答决策：答复单独一块，其他选项默认收起；已关闭另有关闭记录。
  assert.ok(
    await read(
      "(()=>{const a=document.querySelector('[data-testid=\"decision-answer:D-13\"]');return !!a&&a.innerText.includes('你的答复')&&a.innerText.includes('子会话不算，子代理照算')&&a.innerText.includes('子会话已有回报')&&!a.innerText.includes('后台任务页要列出')})()",
    ),
    '答复与问题分块',
  )
  assert.ok(
    await read(
      "document.querySelector('[data-testid=\"decision-answer:D-11\"]').innerText.includes('你在对话中的答复')",
    ),
  )
  assert.ok(
    await read(
      'document.querySelector(\'[data-testid="decision-others:D-13"]\').innerText.includes(\'其他选项 2\') && !document.querySelector(\'[data-testid="manager-issue:D-13"] [data-testid="decision-option:a"]\')',
    ),
    '其他选项默认收起',
  )
  await read(`document.querySelector('[data-testid="decision-others:D-13"]').click()`)
  await wait('[data-testid="manager-issue:D-13"] [data-testid="decision-option:a"]')
  assert.ok(
    await read(
      "document.querySelector('[data-testid=\"decision-closed:D-12\"]').innerText.includes('已关闭 · 经理')",
    ),
    '关闭记录单独一块',
  )
  await read(
    `document.querySelector('[data-testid="manager-issue:D-13"]').scrollIntoView({block:'start'})`,
  )
  await shot('mobile-answered-decision')
  assert.ok(
    await read(
      "document.querySelector('[data-testid=\"issue-status:D-13\"]').textContent.includes('已答复')",
    ),
  )
  assert.ok(
    await read(
      "document.querySelector('[data-testid=\"issue-status:D-12\"]').textContent.includes('已关闭')",
    ),
  )
  assert.ok(
    await read(
      "document.querySelector('[data-testid=\"manager-issue:D-12\"]').innerText.includes('重新打开') && !document.querySelector('[data-testid=\"manager-issue:D-12\"]').innerText.includes('修改答案')",
    ),
    '从未回答的关闭决策仅提供重开',
  )
  // 修改答案：原来的答复照样显示，原选项已选中；点另一项只是选中，不提交
  await press('修改答案')
  await wait('[data-testid="decision-choice:D-13:b"]')
  assert.ok(
    await read('!!document.querySelector(\'[data-testid="decision-answer:D-13"]\')'),
    '修改时保留原答复',
  )
  assert.equal(await checked('decision-choice:D-13:b'), 'true', '原选项已选中')
  await tapId('decision-choice:D-13:a')
  assert.equal(await checked('decision-choice:D-13:a'), 'true')
  assert.equal(await checked('decision-choice:D-13:b'), 'false')
  assert.equal(
    await read('document.querySelector(\'[data-testid="issue-status:D-13"]\').textContent'),
    '草稿',
    '点选项不直接提交，卡片标草稿',
  )
  await read(
    `document.querySelector('[data-testid="manager-issue:D-13"]').scrollIntoView({block:'start'})`,
  )
  await shot('mobile-edit-answer')
  // 选中项是草稿：离开控制台再回来，仍在修改状态、仍选着刚才那项
  await tapId('manager-tab:overview')
  await wait('[data-testid="manager-overview"]')
  await tapId('manager-tab:console')
  await tapId('manager-category:decision')
  await wait('[data-testid="decision-choice:D-13:a"]')
  assert.equal(await checked('decision-choice:D-13:a'), 'true', '离开再回来选中项还在')
  await press('取消修改')
  await wait('[data-testid="decision-others:D-13"]')
  assert.equal(
    await read('document.querySelector(\'[data-testid="issue-status:D-13"]\').textContent'),
    '已答复',
    '取消修改后不再是草稿',
  )
  // 待定决策没选也没写时，“提交给经理”照样显示，旁边写明为什么不能点；没有选项的只提补充说明
  const why = (id) =>
    read(
      `(()=>{const b=document.querySelector('[data-testid="decision-submit:${id}"]');const w=document.querySelector('[data-testid="decision-submit-why:${id}"]');return b&&w?w.textContent:null})()`,
    )
  assert.equal(await why('D-17'), '先写补充说明', '没有选项的决策只提补充说明')
  assert.equal(await why('D-16'), '先选一项或写补充说明', '有选项的决策提选项和补充说明')
  // 说明用次一级的字色（ink-2），与未选中页签的文字同色
  assert.ok(
    await read(
      "(()=>{const w=document.querySelector('[data-testid=\"decision-submit-why:D-17\"]');const tab=document.querySelector('[role=tab][aria-selected=false] div');return !!w&&!!tab&&getComputedStyle(w).color===getComputedStyle(tab).color})()",
    ),
    '不能提交的说明用 ink-2',
  )
  await press('重新打开')
  await until(
    () =>
      read(
        "document.querySelector('[data-testid=\"issue-status:D-12\"]').textContent==='待定' && !!document.querySelector('[data-testid=\"manager-issue:D-12\"] textarea')",
      ),
    '重开后显示答复区',
  )
  // 重开后，上次关闭的原因作历史保留，默认收起
  const history = '[data-testid="decision-previous-closed:D-12"]'
  await wait(history)
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('${history}');return e.innerText.includes('上次关闭 · 经理')&&!e.innerText.includes('feat/mobile-mermaid')})()`,
    ),
    '上次关闭默认收起',
  )
  await read(`document.querySelector('${history} [role=button]').click()`)
  await until(
    () => read(`document.querySelector('${history}').innerText.includes('feat/mobile-mermaid')`),
    '展开看关闭原因',
  )
  await read(
    `document.querySelector('[data-testid="manager-issue:D-12"]').scrollIntoView({block:'start'})`,
  )
  await shot('mobile-reopened-history')
  // 经理把你忽略过的 D-16 重新打开：经理写的理由默认展开（是请你重看的原因），可以收起
  const reopenedNote = '[data-testid="decision-reopened:D-16"]'
  await wait(reopenedNote)
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('${reopenedNote}');return e.innerText.includes('经理重新打开')&&e.innerText.includes('song-pc')})()`,
    ),
    '经理重开的理由默认展开',
  )
  await read(`document.querySelector('${reopenedNote} [role=button]').click()`)
  await until(
    () => read(`!document.querySelector('${reopenedNote}').innerText.includes('song-pc')`),
    '收起经理重开的理由',
  )
  // 忽略 D-17：选填理由确认后标“已忽略”、不计待处理、默认收起；展开看理由，撤销忽略回到待定
  const pendingDecisions = () =>
    read(
      `Number(document.querySelector('[data-testid="manager-category-count:decision"]')?.textContent ?? 0)`,
    )
  const pendingBefore = await pendingDecisions()
  await tapId('decision-ignore:D-17')
  await wait('[data-testid="decision-ignore-form:D-17"]')
  // 确认忽略时作答区收起，卡上只有“确认忽略”一个主按钮
  assert.ok(
    await read(
      `!document.querySelector('[data-testid="decision-submit:D-17"]') && !document.querySelector('[data-testid="manager-issue:D-17"] textarea')`,
    ),
    '确认忽略时收起作答区',
  )
  assert.ok(
    await read(
      `document.querySelector('[data-testid="decision-ignore-form:D-17"]').innerText.includes('经理会收到通知')`,
    ),
    '忽略前说明后果',
  )
  await read(
    `(()=>{const input=document.querySelector('[data-testid="decision-ignore-reason:D-17"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'网关不归这个项目管');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await tapId('decision-ignore-confirm:D-17')
  await until(
    () =>
      read(
        `document.querySelector('[data-testid="issue-status:D-17"]')?.textContent==='已忽略' && !document.querySelector('[data-testid="manager-issue:D-17"] textarea')`,
      ),
    '忽略后标已忽略、收起',
  )
  await until(async () => (await pendingDecisions()) === pendingBefore - 1, '忽略后不计待处理')
  // “展开详情”整行可点、不矮于 44
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('[data-testid="decision-ignored-toggle:D-17"]');const card=document.querySelector('[data-testid="manager-issue:D-17"]').getBoundingClientRect();const r=e.getBoundingClientRect();return e.textContent.trim()==='▸ 展开详情'&&r.height>=44&&r.width>=card.width-48})()`,
    ),
    '已忽略卡片“展开详情”整行可点、高度够',
  )
  await tapId('decision-ignored-toggle:D-17')
  await until(
    () =>
      read(
        `(()=>{const e=document.querySelector('[data-testid="decision-ignored:D-17"]');return !!e&&e.innerText.includes('你已忽略')&&e.innerText.includes('网关不归这个项目管')})()`,
      ),
    '展开看忽略理由',
  )
  await read(
    `document.querySelector('[data-testid="manager-issue:D-17"]').scrollIntoView({block:'start'})`,
  )
  await shot('mobile-ignored-decision')
  await tapId('decision-unignore:D-17')
  await until(
    () =>
      read(
        `document.querySelector('[data-testid="issue-status:D-17"]')?.textContent==='待定' && !!document.querySelector('[data-testid="decision-ignore:D-17"]')`,
      ),
    '撤销忽略回到待定',
  )
  assert.equal(await pendingDecisions(), pendingBefore, '撤销忽略后重新计入待处理')
  // 有草稿的 D-17 被忽略（等同在别处答复或关闭）：不再标草稿、不显示作答区，展开后说明草稿还在，可查看、可丢弃；
  // 撤销忽略后草稿自动回来、可直接提交；丢弃后撤销则什么都不剩
  const d17 = '[data-testid="manager-issue:D-17"]'
  const status17 = () =>
    read(`document.querySelector('[data-testid="issue-status:D-17"]')?.textContent`)
  const area17 = () => read(`document.querySelector('${d17} textarea')?.value ?? null`)
  await read(
    `(()=>{const input=document.querySelector('${d17} textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'先放着的草稿');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await until(async () => (await status17()) === '草稿', 'D-17 标草稿')
  const ignore17 = async () => {
    await tapId('decision-ignore:D-17')
    await tapId('decision-ignore-confirm:D-17')
    await until(async () => (await status17()) === '已忽略', 'D-17 已忽略')
    await tapId('decision-ignored-toggle:D-17')
    await wait('[data-testid="draft-ended:D-17"]')
  }
  await ignore17()
  assert.ok(
    await read(
      `document.querySelector('[data-testid="draft-ended:D-17"]').innerText.includes('草稿还在') && !document.querySelector('${d17} textarea')`,
    ),
    '忽略后说明草稿还在、不显示作答区',
  )
  assert.ok(
    await read(
      `!!(document.querySelector('[data-testid="decision-ignored:D-17"]').compareDocumentPosition(document.querySelector('[data-testid="draft-ended:D-17"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`,
    ),
    '先是“你已忽略”的记录，再是草稿说明',
  )
  await tapId('draft-ended-view:D-17')
  await until(
    () =>
      read(
        `document.querySelector('[data-testid="draft-ended-preview:D-17"]')?.innerText.includes('先放着的草稿')`,
      ),
    '查看草稿',
  )
  await read(`document.querySelector('${d17}').scrollIntoView({block:'start'})`)
  await shot('mobile-ended-draft')
  await tapId('decision-unignore:D-17')
  await until(
    async () =>
      (await status17()) === '草稿' &&
      (await area17()) === '先放着的草稿' &&
      (await read(`!document.querySelector('[data-testid="draft-ended:D-17"]')`)),
    '撤销忽略后草稿回来',
  )
  assert.equal(
    await read(`document.querySelector('[data-testid="decision-submit-why:D-17"]')`),
    null,
    '恢复的草稿可直接提交',
  )
  await ignore17()
  await tapId('draft-ended-discard:D-17')
  // 丢弃要再确认一次，写明不能恢复；确认前草稿还在
  await wait('[data-testid="draft-ended-discarding:D-17"]')
  assert.ok(
    await read(
      `document.querySelector('[data-testid="draft-ended-discarding:D-17"]').innerText.includes('丢弃后不能恢复') && !!document.querySelector('[data-testid="draft-ended:D-17"]')`,
    ),
    '丢弃前确认、写明不能恢复',
  )
  await tapId('draft-ended-discard-confirm:D-17')
  await until(
    () => read(`!document.querySelector('[data-testid="draft-ended:D-17"]')`),
    '丢弃后说明消失',
  )
  await tapId('decision-unignore:D-17')
  await until(
    async () => (await status17()) === '待定' && (await area17()) === '',
    '丢弃后撤销忽略什么都不剩',
  )
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      await read(
        `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:${JSON.stringify(theme)}})`,
      )
      await wait('[data-testid="manager-console"]')
      await tapId('manager-tab:console')
      await tapId('manager-category:decision')
      await read(
        `document.querySelector('[data-testid="manager-issue:D-13"]')?.scrollIntoView({block:'start'})`,
      )
      await shot(`mobile-decisions-${skin}-${theme}`)
      await tapId('manager-tab:overview')
      await wait('[data-testid="manager-overview"]')
      await shot(`mobile-overview-${skin}-${theme}`)
      await tapId('manager-tab:console')
      await tapId('manager-category:report')
      await wait('[data-testid="manager-issue:P-1"]')
      await shot(`mobile-report-${skin}-${theme}`)
      await press('关联 3')
      assert.ok(
        await read(
          "[...document.querySelectorAll('[data-testid=\"manager-issue:P-1\"] [role=button]')].some(e=>e.textContent.includes('#I-2') && [...e.querySelectorAll('*')].some(t=>getComputedStyle(t).textDecorationLine.includes('underline')))",
        ),
        '关联标题显示链接样式',
      )
      await shot(`mobile-relations-${skin}-${theme}`)

      await press('▤ 经理事项#I-2 · 回退编辑：手机端跟进')
      await shot(`mobile-related-item-${skin}-${theme}`)
    }
  await tapId('manager-tab:console')
  await tapId('manager-category:report')
  assert.equal(
    await read('document.querySelector(\'[data-testid="manager-reports-unread"]\').textContent'),
    '1',
  )
  await press('标记已阅')
  await until(
    () => read('!document.querySelector(\'[data-testid="manager-reports-unread"]\')'),
    '报告未读徽标消失',
  )
  await until(
    () =>
      read(
        "document.body.innerText.includes('已阅') && !document.body.innerText.includes('标记已阅')",
      ),
    '标记已阅',
  )
  await press('追问')
  assert.equal(
    await read("document.querySelector('textarea').getAttribute('aria-label')"),
    await read("document.querySelector('textarea').placeholder"),
    '读屏名称与经理模式占位一致',
  )
  await press('临时对话')
  assert.equal(
    await read("document.querySelector('textarea').getAttribute('aria-label')"),
    await read("document.querySelector('textarea').placeholder"),
    '读屏名称与临时模式占位一致',
  )
  await press('经理对话')
  await read(
    `(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'手机追问范围');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await new Promise((r) => setTimeout(r, 150))
  await shot('mobile-question-compose')
  await press('提交追问')
  await until(() => read("document.body.innerText.includes('已核对这条内容')"), '经理回复')
  assert.ok(await read("!document.querySelector('textarea')"), '提交后收起追问')
  await shot('mobile-report-discussion')
  await tapId('manager-category:request')
  assert.ok(
    await read(
      "!document.querySelector('[data-testid=\"manager-issue:R-1\"]').innerText.includes('提交给经理')",
    ),
    '无文字草稿不显示第二个提交按钮',
  )
  await shot('mobile-request-empty')
  await read(
    `(()=>{const input=document.querySelector('[data-testid="manager-issue:R-1"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'暂时受阻');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await until(
    () =>
      read(
        "[...document.querySelectorAll('[data-testid=\"manager-issue:R-1\"] [role=button]')].some(e=>e.textContent==='提交给经理')",
      ),
    '文字回复按钮出现',
  )
  assert.ok(
    await read(
      "(()=>{const buttons=[...document.querySelectorAll('[data-testid=\"manager-issue:R-1\"] [role=button]')];return getComputedStyle(buttons.find(e=>e.textContent==='已复验')).backgroundColor !== getComputedStyle(buttons.find(e=>e.textContent==='提交给经理')).backgroundColor})()",
    ),
    '文字提交是次要按钮',
  )
  await shot('mobile-request-text')
  await press('提交给经理')
  await until(
    () =>
      read("document.querySelector('[data-testid=\"issue-status:R-1\"]').textContent==='已回复'"),
    '文字回复',
  )
  await press('修改回复')
  await press('已复验')
  await until(() => read("document.body.innerText.includes('已交付')"), '交付请求')
  await shot('mobile-delivery')
  // 概览：与桌面同样的两个数；受阻事项第二行“等待决策 #D-15”，编号可点
  await tapId('manager-tab:overview')
  await wait('[data-testid="manager-overview"]')
  assert.ok(
    await read(
      "['wait','done'].every(k=>document.querySelector(`[data-testid=\"manager-stat:${k}\"]`)) && !document.querySelector('[data-testid=\"manager-stat:lines\"]')",
    ),
    '概览数字与桌面一致',
  )
  assert.ok(
    await read(
      "document.querySelector('[data-testid=\"overview-blocked:I-2\"]').innerText.includes('等待决策')",
    ),
    '受阻事项写明等待决策',
  )
  await tapId('overview-blocked:I-2:D-15')
  await wait('[data-testid="manager-issue:D-15"]')
  assert.equal(await checked('manager-category:decision'), 'true', '编号跳到决策')
  await tapId('manager-tab:overview')
  await tapId('manager-stat:wait')
  await wait('[data-testid="manager-issue-order"]')
  // 比应用旧的设备服务（本机在跑旧版）：页顶写明哪些不可用、去设备详情升级；入口禁用并写原因，答复照常
  await call('Page.navigate', {
    url: url.replace('scene=manager-console', 'scene=manager-old-device'),
  })
  await wait('[data-testid="manager-old-device"]')
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('[data-testid="manager-old-device"]').innerText;return e.includes('设备详情里升级设备服务')&&e.includes('忽略决策')&&e.includes('请你做的交付与回复')})()`,
    ),
    '设备服务较旧：页顶写明不可用的功能与升级去处',
  )
  const disabledWithReason = (button, reason) =>
    read(
      `document.querySelector('[data-testid="${button}"]')?.getAttribute('aria-disabled')==='true' && (document.querySelector('[data-testid="${reason}"]')?.textContent??'').includes('升级后可用')`,
    )
  await wait('[data-testid="decision-ignore:D-17"]')
  assert.ok(
    await disabledWithReason('decision-ignore:D-17', 'old-device-reason:ignore:D-17'),
    '设备服务较旧：忽略禁用并写原因',
  )
  assert.ok(
    await disabledWithReason('post-ask:D-17', 'old-device-reason:posts:D-17'),
    '设备服务较旧：追问禁用并写原因',
  )
  await tapId('manager-category:request')
  await wait('[data-testid="request-deliver:R-1"]')
  assert.ok(
    await disabledWithReason('request-deliver:R-1', 'old-device-reason:feedback:R-1'),
    '设备服务较旧：请你做的交付禁用并写原因',
  )
  await tapId('manager-category:decision')
  await wait('[data-testid="manager-issue:D-17"] textarea')
  await read(
    `(()=>{const input=document.querySelector('[data-testid="manager-issue:D-17"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'旧设备上照常答复');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await tapId('decision-submit:D-17')
  await until(
    () =>
      read(`document.querySelector('[data-testid="issue-status:D-17"]')?.textContent==='已答复'`),
    '设备服务较旧：决策答复照常交上',
  )
  await shot('mobile-old-device')
  // 经理目录：按设备分组。
  await call('Page.navigate', { url: url.replace('scene=manager-console', 'scene=managers') })
  await wait('[data-testid="managers:device:local"]')
  assert.ok(await read('!!document.querySelector(\'[data-testid="manager:m1"]\')'), '经理目录')
  // 有待处理的经理：行尾等待色的计数胶囊
  assert.ok(
    await read(
      '(()=>{const p=document.querySelector(\'[data-testid="manager:m1:pending"]\');return !!p&&/^\\d+$/.test(p.textContent)})()',
    ),
    '待处理计数胶囊',
  )
  // 读屏念整行时带上“N 待处理”，不只放在胶囊上
  assert.ok(
    await read(
      "(()=>{const row=document.querySelector('[data-testid=\"manager:m1\"]');const n=document.querySelector('[data-testid=\"manager:m1:pending\"]').textContent;return (row.getAttribute('aria-label')||'').includes(n+' 待处理')})()",
    ),
    '经理行的读屏名称带待处理数',
  )
  // m2 自己回合已停、挂着后台命令，另有工作线在跑：记号是后台的呼吸记号，文字写工作线（与桌面 session-mark 同规则）
  assert.ok(
    await read(
      '(()=>{const row=document.querySelector(\'[data-testid="manager:m2"]\');return !!row&&!!row.querySelector(\'[data-testid="mark:background"]\')&&/\\d+ 条工作线运行中/.test(row.textContent)})()',
    ),
    '经理行记号只看经理自己，工作线在跑另写文字',
  )
  await shot('mobile-managers')
  console.log(
    '手机经理：目录、概览、排序、已答决策分块、三皮肤报告、关联定位、已阅、追问与交付、设备服务较旧通过',
  )
} catch (error) {
  console.error(error)
  throw error
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  console.log(`隔离浏览器已关闭，临时目录：${work}`)
}
