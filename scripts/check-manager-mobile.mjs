// 手机控制台的正式页面预览；npm run client:check:manager-mobile 自动起停隔离预览。
// 已有预览也可直接传 URL：node scripts/check-manager-mobile.mjs '<完整预览 URL>'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
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
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]),
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
let failureEvidence
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
    // 此脚本只驱动模拟核心；正式发送入口弹出的数据同意按用户发送动作确认。
    // 同意流程自身由 privacy 专项测试覆盖，不能让它挡住后续布局断言。
    await call('Runtime.evaluate', {
      expression: `document.querySelector('[data-testid="ai-consent:allow"]')?.click()`,
    })
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }).catch((cause) => {
      throw new Error(`页面表达式失败：${expression}`, { cause })
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

  failureEvidence = async () => {
    await shot('failure')
    writeFileSync(join(output, 'failure.txt'), await read('document.body.innerText'))
    writeFileSync(join(output, 'failure.html'), await read('document.documentElement.outerHTML'))
  }

  await call('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  await wait('[data-testid="manager-console"]')
  assert.equal(
    await read(
      'document.querySelector(\'[data-testid="manager-tab:console"]\').getAttribute("aria-selected")',
    ),
    'true',
    '未指定页签时默认控制台',
  )
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
    if (process.env.LITCH_SMOKE_TRACE) console.log('入口', id)
    await wait(`[data-testid="${id}"]`)
    await read(`document.querySelector('[data-testid="${id}"]').click()`)
    await new Promise((r) => setTimeout(r, 150))
  }
  const checked = (id) =>
    read(`document.querySelector('[data-testid="${id}"]')?.getAttribute('aria-checked')`)
  const closeSheet = async () => {
    if (await read(`!!document.querySelector('[data-testid="discussion-drawer:close"]')`)) {
      await tapId('discussion-drawer:close')
      await until(
        () => read(`!document.querySelector('[data-testid^="issue-sheet:"]')`),
        '关闭议题抽屉',
      )
    }
  }
  const category = async (kind) => {
    await closeSheet()
    await tapId('manager-tab:console')
    await tapId(`issue-capsule:${kind}`)
  }
  const openIssue = async (id) => {
    await closeSheet()
    await tapId(`issue-card:${id}`)
    await wait(`[data-testid="issue-sheet:${id}"] [data-testid="manager-issue:${id}"]`)
  }
  const status = (id, label) =>
    read(
      `document.querySelector('[data-testid="issue-sheet:${id}"] [data-testid="issue-meta:${id}"]')?.textContent.includes(${JSON.stringify(label)})`,
    )
  const fill = async (selector, value) => {
    await wait(selector)
    await read(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
  }
  const noteOpen = async (id) => {
    if (!(await read(`!!document.querySelector('[data-testid="manager-issue:${id}"] textarea')`)))
      await tapId(`decision-note-open:${id}`)
  }
  const checkGrowth = async (selector, label) => {
    const size = () =>
      read(
        `(()=>{const input=document.querySelector(${JSON.stringify(selector)});return {height:input.getBoundingClientRect().height,client:input.clientHeight,scroll:input.scrollHeight}})()`,
      )
    const minimum = (await size()).height
    await fill(selector, '第一行\n第二行\n第三行\n第四行')
    await until(async () => (await size()).height > minimum + 10, `${label}四行增高`)
    const four = await size()
    assert.ok(four.scroll <= four.client + 1, `${label}四行完整显示`)
    await fill(selector, '')
    await until(async () => (await size()).height <= minimum + 1, `${label}清空恢复`)
  }
  // 工作台四格；issue 胶囊单选，默认只列待处理，摘要卡按需打开抽屉。
  assert.equal(
    await read(
      "[...document.querySelectorAll('[role=tab][data-testid^=\"manager-tab:\"]')].map(e=>e.dataset.testid.slice(12)).join(',')",
    ),
    'console,chat,lines,overview',
    '页签顺序',
  )
  assert.equal(await checked('issue-capsule:decision'), 'true', '类别是单选')
  const decisionOrder = () =>
    read(
      "[...document.querySelectorAll('[data-testid^=\"issue-card:D-\"]')].map(e=>e.dataset.testid.slice(11)).join(',')",
    )
  await until(async () => (await decisionOrder()) === 'D-17,D-16,D-15', '默认只列待处理决策')
  assert.equal(
    await read(`document.querySelectorAll('[data-testid="issue-list"] textarea').length`),
    0,
    '摘要列表不挂载作答区',
  )
  await tapId('issue-status:all')
  await until(
    async () => (await decisionOrder()) === 'D-17,D-16,D-15,D-13,D-12,D-11',
    '全部状态最新优先',
  )
  const order = async (key) => {
    await tapId('issue-filter-open')
    assert.equal(
      await read(
        `document.querySelector('[data-testid="issue-filter-order:${key}"]').getAttribute('role')`,
      ),
      'radio',
      '排序是单选',
    )
    await tapId(`issue-filter-order:${key}`)
    await tapId('issue-filter-done')
  }
  await order('oldest')
  await until(async () => (await decisionOrder()) === 'D-11,D-12,D-13,D-15,D-16,D-17', '最早优先')
  await shot('mobile-order-oldest')
  await order('pending')
  await until(async () => (await decisionOrder()).startsWith('D-17,D-16,D-15'), '待处理优先')
  await order('newest')
  await openIssue('D-13')
  // 卡片外壳先出现，Markdown 经异步 WASM 解析后才挂正文；等正文完成再验分块。
  await until(
    () =>
      read(
        "(()=>{const a=document.querySelector('[data-testid=\"decision-answer:D-13\"]');return !!a&&a.innerText.includes('你的答复')&&a.innerText.includes('子会话不算，子代理照算')&&a.innerText.includes('子会话已有回报')&&!a.innerText.includes('后台任务页要列出')})()",
      ),
    '答复正文完成并与问题分块',
  )
  assert.ok(
    await read(
      `document.querySelector('[data-testid="decision-others:D-13"]').innerText.includes('其他选项 2') && !document.querySelector('[data-testid="decision-option:a"]')`,
    ),
    '其他选项默认收起',
  )
  await tapId('decision-others:D-13')
  await wait('[data-testid="decision-option:a"]')
  assert.ok(await status('D-13', '已答复'))
  await shot('mobile-answered-decision')
  await press('修改答案')
  await wait('[data-testid="decision-choice:D-13:b"]')
  assert.ok(
    await read(`!!document.querySelector('[data-testid="decision-answer:D-13"]')`),
    '修改时保留原答复',
  )
  assert.equal(await checked('decision-choice:D-13:b'), 'true', '原选项已选中')
  await tapId('decision-choice:D-13:a')
  assert.equal(await checked('decision-choice:D-13:a'), 'true')
  assert.equal(await checked('decision-choice:D-13:b'), 'false')
  assert.ok(await status('D-13', '已答复'), '点选项不直接提交')
  await shot('mobile-edit-answer')
  await closeSheet()
  await tapId('manager-tab:overview')
  await wait('[data-testid="manager-overview"]')
  await tapId('manager-tab:console')
  await openIssue('D-13')
  await wait('[data-testid="decision-choice:D-13:a"]')
  assert.equal(await checked('decision-choice:D-13:a'), 'true', '离开再回来选中项还在')
  await press('取消修改')
  await wait('[data-testid="decision-others:D-13"]')
  assert.ok(await status('D-13', '已答复'), '取消修改后保留原状态')
  await openIssue('D-11')
  assert.ok(
    await read(
      `document.querySelector('[data-testid="decision-answer:D-11"]').innerText.includes('你在对话中的答复')`,
    ),
  )
  await openIssue('D-12')
  assert.ok(
    await read(
      `document.querySelector('[data-testid="decision-closed:D-12"]').innerText.includes('已关闭 · 经理')`,
    ),
    '关闭记录单独一块',
  )
  assert.ok(
    await read(
      `document.querySelector('[data-testid="manager-issue:D-12"]').innerText.includes('重新打开') && !document.querySelector('[data-testid="manager-issue:D-12"]').innerText.includes('修改答案')`,
    ),
    '从未回答的关闭决策仅提供重开',
  )
  // 待定决策没选也没写时，“提交给经理”照样显示，旁边写明为什么不能点；没有选项的只提补充说明
  const why = (id) =>
    read(
      `(()=>{const b=document.querySelector('[data-testid="decision-submit:${id}"]');const w=document.querySelector('[data-testid="decision-submit-why:${id}"]');return b&&w?w.textContent:null})()`,
    )
  await openIssue('D-17')
  assert.equal(await why('D-17'), '先写补充说明', '没有选项的决策只提补充说明')
  await openIssue('D-16')
  assert.equal(await why('D-16'), '先选一项或写补充说明', '有选项的决策提选项和补充说明')
  // 说明用次一级的字色（ink-2），与未选中页签的文字同色
  assert.ok(
    await read(
      "(()=>{const w=document.querySelector('[data-testid=\"decision-submit-why:D-16\"]');const tab=document.querySelector('[role=tab][aria-selected=false] div');return !!w&&!!tab&&getComputedStyle(w).color===getComputedStyle(tab).color})()",
    ),
    '不能提交的说明用 ink-2',
  )
  await openIssue('D-12')
  await press('重新打开')
  await wait('[data-testid="decision-submit:D-12"]')
  await noteOpen('D-12')
  await wait('[data-testid="manager-issue:D-12"] textarea')
  await checkGrowth('[data-testid="manager-issue:D-12"] textarea', '决策补充说明')
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
  await openIssue('D-16')
  const reopenedNote = '[data-testid="decision-reopened:D-16"]'
  await wait(reopenedNote)
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('${reopenedNote}');return e.innerText.includes('经理重新打开')&&e.innerText.includes('win-test')})()`,
    ),
    '经理重开的理由默认展开',
  )
  await read(`document.querySelector('${reopenedNote} [role=button]').click()`)
  await until(
    () => read(`!document.querySelector('${reopenedNote}').innerText.includes('win-test')`),
    '收起经理重开的理由',
  )
  // 忽略 D-17：选填理由确认后标“已忽略”、不计待处理、默认收起；展开看理由，撤销忽略回到待定
  const pendingDecisions = () =>
    read(
      `Number(document.querySelector('[data-testid="issue-capsule:decision"]')?.textContent.replace(/[^0-9]/g,'') ?? 0)`,
    )
  const pendingBefore = await pendingDecisions()
  await openIssue('D-17')
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
        `document.querySelector('[data-testid="issue-sheet:D-17"] [data-testid="issue-meta:D-17"]')?.textContent.includes('已忽略') && !document.querySelector('[data-testid="manager-issue:D-17"] textarea')`,
      ),
    '忽略后标已忽略、收起',
  )
  await until(async () => (await pendingDecisions()) === pendingBefore - 1, '忽略后不计待处理')
  // issue 摘要卡按需打开，抽屉内直接显示忽略记录。
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
    () => read(`!!document.querySelector('[data-testid="decision-ignore:D-17"]')`),
    '撤销忽略回到待定',
  )
  assert.equal(await pendingDecisions(), pendingBefore, '撤销忽略后重新计入待处理')
  // 有草稿的 D-17 被忽略（等同在别处答复或关闭）：不再标草稿、不显示作答区，展开后说明草稿还在，可查看、可丢弃；
  // 撤销忽略后草稿自动回来、可直接提交；丢弃后撤销则什么都不剩
  const d17 = '[data-testid="manager-issue:D-17"]'
  const area17 = () => read(`document.querySelector('${d17} textarea')?.value ?? null`)
  await read(
    `(()=>{const input=document.querySelector('${d17} textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'先放着的草稿');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await until(async () => (await area17()) === '先放着的草稿', 'D-17 保留草稿')
  const ignore17 = async () => {
    await tapId('decision-ignore:D-17')
    await tapId('decision-ignore-confirm:D-17')
    await until(() => status('D-17', '已忽略'), 'D-17 已忽略')
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
    async () =>
      (await area17()) === '' &&
      (await read(`!!document.querySelector('[data-testid="decision-ignore:D-17"]')`)),
    '丢弃后撤销忽略什么都不剩',
  )
  await closeSheet()
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      await read(
        `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:${JSON.stringify(theme)}})`,
      )
      await wait('[data-testid="manager-console"]')
      await tapId('manager-tab:console')
      await category('decision')
      await tapId('issue-status:all')
      await openIssue('D-13')
      await shot(`mobile-decisions-${skin}-${theme}`)
      await closeSheet()
      await tapId('manager-tab:overview')
      await wait('[data-testid="manager-overview"]')
      await shot(`mobile-overview-${skin}-${theme}`)
      await tapId('manager-tab:console')
      await category('report')
      await openIssue('P-1')
      await shot(`mobile-report-${skin}-${theme}`)
      await tapId('relations:P-1')
      assert.ok(
        await read(
          `(()=>{const a=document.querySelector('[data-testid="relation:I-2"]');return !!a&&a.textContent.includes('#I-2')&&[...a.querySelectorAll('*')].some(t=>getComputedStyle(t).textDecorationLine.includes('underline'))})()`,
        ),
        '关联标题显示链接样式',
      )
      await shot(`mobile-relations-${skin}-${theme}`)
      await tapId('relation:I-2')
      await wait('[data-testid="manager-overview"]')
      assert.ok(
        await read(
          `document.querySelector('[data-testid="manager-overview"]').textContent.includes('回退编辑')`,
        ),
        '关联定位经理事项',
      )
      await shot(`mobile-related-item-${skin}-${theme}`)
      await closeSheet()
    }
  await category('report')
  assert.match(
    await read(`document.querySelector('[data-testid="issue-capsule:report"]').textContent`),
    /1/,
    '报告待处理计数',
  )
  await tapId('issue-status:all')
  await openIssue('P-1')
  await tapId('report-read:P-1')
  await until(
    () =>
      read(
        `!document.querySelector('[data-testid="issue-capsule:report"]').textContent.match(/\\d/)`,
      ),
    '报告待处理计数消失',
  )
  await until(() => status('P-1', '已读'), '标记已阅')
  const reportCard = '[data-testid="issue-card:P-1"]'
  const drawer = '[data-testid="issue-sheet:P-1"]'
  assert.ok(
    await read(`!document.querySelector('[data-testid="manager-issue:P-1"] textarea')`),
    '正文里没有评论输入',
  )
  assert.ok(
    await read(
      `(document.querySelector('[data-testid="post-discussion:P-1"]')?.getAttribute('aria-label')??'').includes('打开讨论')`,
    ),
    '讨论入口带读屏名称',
  )
  await tapId('post-discussion:P-1')
  await wait('[data-testid="issue-comment-input"]')
  assert.ok(
    await read(`!document.querySelector('[data-testid="issue-original"]')`),
    '讨论不重复正文',
  )
  const viewport = await read('innerHeight')
  const drawerHeight = () =>
    read(`Math.round(document.querySelector('${drawer}').getBoundingClientRect().height)`)
  const halfHeight = await drawerHeight()
  assert.ok(
    halfHeight > viewport * 0.4 && halfHeight < viewport * 0.7,
    `抽屉先占半屏：${halfHeight}/${viewport}`,
  )
  await tapId('discussion-drawer:size')
  await until(async () => (await drawerHeight()) > viewport * 0.85, '抽屉展开到全屏')
  await shot('mobile-discussion-full')
  await tapId('discussion-drawer:size')
  await until(async () => (await drawerHeight()) < viewport * 0.7, '抽屉收回半屏')
  const dragDrawer = async (dy) => {
    const point = await read(
      `(()=>{const r=document.querySelector('[data-testid="discussion-drawer:grip"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    for (let n = 1; n <= 6; n++)
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y + (dy * n) / 6,
        button: 'left',
        buttons: 1,
      })
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y + dy,
      button: 'left',
      clickCount: 1,
    })
  }
  await dragDrawer(-100)
  await until(async () => (await drawerHeight()) > viewport * 0.85, '拖动展开全屏')
  await dragDrawer(100)
  await until(async () => (await drawerHeight()) < viewport * 0.7, '拖动收回半屏')
  const questionSelector = '[data-testid="issue-comment-input"]'
  assert.equal(
    await read(`document.querySelector('${questionSelector}').getAttribute('aria-label')`),
    await read(`document.querySelector('${questionSelector}').placeholder`),
    '评论输入读屏名称与占位一致',
  )
  const fillQuestion = (value) => fill(questionSelector, value)
  const questionSize = () =>
    read(
      `(()=>{const input=document.querySelector('${questionSelector}');const style=getComputedStyle(input);return {height:input.getBoundingClientRect().height,scroll:input.scrollHeight,client:input.clientHeight,max:parseFloat(style.maxHeight),resize:style.resize,overflow:style.overflowY}})()`,
    )
  const questionMinimum = (await questionSize()).height
  await fillQuestion('第一行\n第二行\n第三行\n第四行')
  await until(async () => (await questionSize()).height > questionMinimum + 10, '手机四行评论增高')
  const fourLines = await questionSize()
  assert.ok(fourLines.scroll <= fourLines.client + 1, '四行评论完整显示')
  await read(
    `document.querySelector('${questionSelector}').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`,
  )
  assert.equal((await questionSize()).height, fourLines.height, '组字事件不收缩输入框')
  await read(
    `document.querySelector('${questionSelector}').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}))`,
  )
  await fillQuestion(Array.from({ length: 40 }, (_, i) => `第 ${i} 行`).join('\n'))
  await until(
    async () => (await questionSize()).scroll > (await questionSize()).client,
    '手机评论达到上限',
  )
  const cappedQuestion = await questionSize()
  assert.ok(cappedQuestion.height <= cappedQuestion.max + 1)
  assert.equal(cappedQuestion.overflow, 'auto')
  assert.equal(cappedQuestion.resize, 'none')
  await fillQuestion('')
  await until(async () => (await questionSize()).height <= questionMinimum + 1, '手机评论清空恢复')
  await fillQuestion('手机评论范围')
  await shot('mobile-question-compose')
  await closeSheet()
  await openIssue('P-1')
  await tapId('post-discussion:P-1')
  await wait(questionSelector)
  assert.equal(
    await read(`document.querySelector('${questionSelector}').value`),
    '手机评论范围',
    '关开抽屉保留评论草稿',
  )
  await tapId('issue-comment-send')
  await until(
    () =>
      read(
        `document.querySelector('${drawer} [data-testid^="issue-comment:"]')?.textContent.includes('手机评论范围')`,
      ),
    '评论保存并出现在讨论中',
  )
  assert.equal(await read(`document.querySelector('${questionSelector}').value`), '', '提交后清空')
  await shot('mobile-report-discussion')
  await closeSheet()
  assert.ok(
    await read(
      `!document.querySelector('${reportCard}').innerText.includes('手机评论范围') && !document.querySelector('${questionSelector}')`,
    ),
    '摘要卡不包含讨论全文或输入框',
  )
  // 窄手机仍能看见原卡片，点抽屉标题返回并定位；切到另一帖子只显示其抽屉。
  await call('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await openIssue('P-1')
  await tapId('post-discussion:P-1')
  await wait(questionSelector)
  await until(
    () =>
      read(
        `(()=>{const r=document.querySelector('${drawer}').getBoundingClientRect();return r.top>innerHeight*0.3&&r.bottom<=innerHeight+1&&r.right<=innerWidth})()`,
      ),
    '窄手机保留上方卡片空间',
  )
  await shot('mobile-discussion-narrow')
  await read(`document.querySelector('${drawer} [aria-label^="回到卡片"]').click()`)
  await until(
    () =>
      read(
        `!document.querySelector('${drawer}') && document.querySelector('${reportCard}').getBoundingClientRect().top>=0`,
      ),
    '标题回到卡片',
  )
  await call('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await category('request')
  await openIssue('R-1')
  await tapId('post-discussion:R-1')
  await wait('[data-testid="issue-sheet:R-1"] [data-testid="issue-comment-input"]')
  assert.equal(
    await read(
      `document.querySelectorAll('[data-testid^="issue-sheet:"]:not([data-testid$=":open"])').length`,
    ),
    1,
    '只打开当前议题的抽屉',
  )
  await closeSheet()
  await openIssue('R-1')
  assert.ok(
    await read(
      "!document.querySelector('[data-testid=\"manager-issue:R-1\"]').innerText.includes('提交给经理')",
    ),
    '无文字草稿不显示第二个提交按钮',
  )
  await shot('mobile-request-empty')
  await tapId('request-reply-open:R-1')
  await checkGrowth('[data-testid="request-reply:R-1"]', '请你做回复')
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
  await until(() => status('R-1', '已回复'), '文字回复')
  await press('修改回复')
  await press('已复验')
  await until(() => read("document.body.innerText.includes('已交付')"), '交付请求')
  await shot('mobile-delivery')
  await closeSheet()
  // 概览：与桌面一样只有控制台四类计数和现状，点计数到控制台那一类；受阻事项、时间线不再出现
  await tapId('manager-tab:overview')
  await wait('[data-testid="manager-overview"]')
  assert.ok(
    await read(
      "['decision','request','report','suggestion'].every(k=>document.querySelector(`[data-testid=\"overview-count:${k}\"]`)) && document.querySelector('[data-testid=\"overview-situation\"]') && !document.querySelector('[data-testid^=\"overview-blocked\"],[data-testid^=\"manager-activity\"],[data-testid^=\"manager-stat\"]')",
    ),
    '概览只有控制台四类计数和现状',
  )
  await tapId('overview-count:request')
  await wait('[data-testid="issue-capsule:ordinary"]')
  assert.equal(await checked('issue-capsule:request'), 'true', '概览计数跳到请你做')
  await wait('[data-testid="issue-card:R-1"]')
  assert.ok(
    await read(`!document.querySelector('[data-testid^="issue-card:X-"]')`),
    '请求入口不混入普通 issue',
  )
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
    await disabledWithReason('post-discussion:D-17', 'old-device-reason:posts:D-17'),
    '设备服务较旧：追问禁用并写原因',
  )
  await tapId('manager-category:request')
  await wait('[data-testid="request-deliver:R-1"]')
  assert.ok(
    await disabledWithReason('request-deliver:R-1', 'old-device-reason:feedback:R-1'),
    '设备服务较旧：请你做的交付禁用并写原因',
  )
  await tapId('manager-category:decision')
  await wait('[data-testid="decision-submit:D-17"]')
  // 有选项的决策补充说明默认收起，先展开
  await noteOpen('D-17')
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
  // 显式对话链接仍落在对话；正文编号拉起半屏卡，↗ 打开完整讨论并返回原页；切页签草稿保留
  await call('Page.navigate', { url: url.replace('scene=manager-console', 'scene=manager-chat') })
  await wait('[data-testid="manager-chat"] textarea')
  assert.equal(
    await read(
      "document.querySelector('[data-testid=\"manager-tab:chat\"]').getAttribute('aria-selected')",
    ),
    'true',
    '显式对话链接不受默认页签改变影响',
  )
  assert.ok(
    await read(
      "/^\\d+$/.test(document.querySelector('[data-testid=\"manager-tab-badge:console\"]')?.textContent??'')",
    ),
    '控制台页签挂待处理数',
  )
  await until(
    () =>
      read(
        "(()=>{const a=[...document.querySelectorAll('[data-testid=\"manager-chat\"] a')].find(e=>e.getAttribute('href')==='litch-issue:D-16');if(!a)return false;a.click();return true})()",
      ),
    '对话里的 D-16 链接',
  )
  await wait('[data-testid="issue-sheet:D-16"]')
  assert.ok(
    await read(
      '!!document.querySelector(\'[data-testid="issue-sheet:D-16"] [data-testid="manager-issue:D-16"]\')',
    ),
    '半屏里是那张议题卡',
  )
  await tapId('issue-sheet:D-16:open')
  await wait('[data-testid="manager-issue"]')
  await wait('[data-testid="issue-comment-input"]')
  await read(
    `document.querySelector('[data-testid="manager-issue"] [data-testid="header:back"]').click()`,
  )
  await wait('[data-testid="manager-console"]')
  assert.equal(
    await read(
      `document.querySelector('[data-testid="manager-tab:chat"]').getAttribute('aria-selected')`,
    ),
    'true',
    '完整讨论返回到原对话页签',
  )
  await tapId('manager-tab:chat')
  await read(
    "(()=>{const t=document.querySelector('[data-testid=\"manager-chat\"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'草稿');t.dispatchEvent(new Event('input',{bubbles:true}))})()",
  )
  await tapId('manager-tab:lines')
  await wait('[data-testid="manager-lines"]')
  // 等人、出错在前，运行中、空闲依次；已合并的收在“已结束”
  assert.ok(
    await read('!!document.querySelector(\'[data-testid="manager-lines:ended"]\')'),
    '已结束一组',
  )
  assert.ok(
    await read('!!document.querySelector(\'[data-testid="manager-line:manager-k1:unverified"]\')'),
    '没验计数',
  )
  await tapId('manager-tab:chat')
  assert.equal(
    await read('document.querySelector(\'[data-testid="manager-chat"] textarea\').value'),
    '草稿',
    '切页签草稿还在',
  )
  await shot('mobile-workbench-chat')
  // 工作线直达：副标题“↰ 经理名”，点了到经理页的工作线页签
  await call('Page.navigate', {
    url: url.replace('scene=manager-console', 'scene=manager-line-origin'),
  })
  await tapId('detail:manager')
  await wait('[data-testid="manager-lines"]')
  assert.equal(
    await read(
      "document.querySelector('[data-testid=\"manager-tab:lines\"]').getAttribute('aria-selected')",
    ),
    'true',
    '工作线回经理落在工作线页签',
  )
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
    '手机经理：工作台四格、编号半屏议题卡、工作线与回经理、目录、概览、排序、已答决策分块、三皮肤报告、关联定位、已阅、评论增高与交付、设备服务较旧通过',
  )
} catch (error) {
  await failureEvidence?.().catch((e) => console.error('失败证据采集失败', e))
  console.error(error)
  throw error
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  console.log(`隔离浏览器已关闭，临时目录：${work}`)
}
