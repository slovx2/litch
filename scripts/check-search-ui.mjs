// S1 隔离浏览器验收。自动启动回环 Vite，只控制自己创建的 headless CFT。
// 用法：npm run client:check:search；也可用 LITCH_SEARCH_UI 指向已启动的回环夹具。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkSearchR3 } from './check-search-r3.mjs'
import { checkSearchReview } from './check-search-review.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

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
if (!binary?.includes('for Testing')) throw new Error('需要隔离 Chrome for Testing')
let base = process.env.LITCH_SEARCH_UI
if (base && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('只接受回环夹具')
const work = mkdtempSync(join(tmpdir(), 'litch-search-ui-'))
const outputBase = resolve('.local/search-ui')
const output = join(outputBase, `${Date.now()}-${process.pid}`)
mkdirSync(output, { recursive: true })
const report = { checks: [], success: false, work, output }
let vite
if (!base) {
  const reserve = createServer()
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise((resolve) => reserve.close(resolve))
  base = `http://127.0.0.1:${port}`
  vite = spawn(
    process.execPath,
    [
      resolve('packages/ui/node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: resolve('packages/ui'),
      env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex') },
      stdio: 'ignore',
    },
  )
}
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--window-size=1200,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex'), TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let cdp
let log = ''
child.stderr.on('data', (data) => {
  log += data.toString()
})
try {
  await until(async () => (await fetch(`${base}/test/search-fixture.html`)).ok, '回环界面服务')
  const port = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '浏览器端口',
  )
  assert.ok(
    execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).includes(
      `${work}/profile`,
    ),
  )
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  cdp = await Cdp.connect(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  const errors = []
  cdp.listeners.add((message) => {
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(
        message.params.exceptionDetails.text +
          ': ' +
          message.params.exceptionDetails.exception?.description,
      )
  })
  const evaluate = async (expression) => {
    const r = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  await cdp.call('Page.navigate', { url: `${base}/test/search-fixture.html` })
  await until(() => evaluate(`!!document.querySelector('.search-entry')`), '对话入口')
  await evaluate(`document.querySelector('.search-entry').click()`)
  await until(() => evaluate(`!!document.querySelector('.search-bar input')`), '搜索框')
  const before = await evaluate(
    `({turns:document.querySelectorAll('.turn').length,early:!!document.querySelector('[data-search-turn="t0"]')})`,
  )
  assert.equal(before.early, false)
  report.checks.push({ name: '早期命中尚未挂载', ...before })
  const query = async (text) => {
    const frameMs = await evaluate(
      `new Promise(resolve=>{const start=performance.now();const input=document.querySelector('.search-bar input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));requestAnimationFrame(()=>resolve(performance.now()-start));})`,
    )
    await until(
      () =>
        evaluate(
          `!document.querySelector('.search-count').textContent.includes('正在') && !!CSS.highlights.get('litch-find-current')?.size`,
        ),
      `查询 ${text}`,
    )
    const result = await evaluate(
      `(()=>{const range=[...CSS.highlights.get('litch-find-current')][0];const rect=range.getBoundingClientRect();return {text:range.toString(),count:document.querySelector('.search-count').textContent,visible:rect.bottom>0&&rect.top<innerHeight,mounted:document.querySelectorAll('.turn').length};})()`,
    )
    report.checks.push({ name: text, frameMs, ...result })
    assert.ok(frameMs < 100, `${text} 输入响应 ${frameMs}ms`)
    assert.ok(result.visible, `${text} 不在视口`)
    assert.equal(
      result.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '),
      text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '),
      '高亮须属于当前查询',
    )
    return result
  }
  assert.equal((await query('跨节点匹配')).text, '跨节点匹配')
  await query('ThoughtNeedle')
  await query('ProcessNeedle')
  await query('CodeNeedle')
  await query('ｃｏｄｅｎｅｅｄｌｅ')
  await query('最早中文')
  await query('👩‍💻')
  await query('i̇stanbul')
  await query('PlanNeedle')
  await query('QuestionNeedle')
  await query('AnswerNeedle')
  await query('OptionNeedle')
  await query('CommentNeedle')
  await query('QuoteNeedle')
  await evaluate(
    `(()=>{const input=document.querySelector('.search-bar input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'ToolNeedle');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  )
  await until(
    () => evaluate(`document.querySelector('.search-count').textContent.includes('未找到')`),
    '排除工具',
  )
  report.checks.push({ name: '工具不参与搜索' })
  await evaluate(`window.searchFixture.append(' StreamingNeedle')`)
  await query('StreamingNeedle')
  await evaluate(`window.searchFixture.replaceFirst('ReplacementNeedle')`)
  await query('ReplacementNeedle')
  await evaluate(`window.searchFixture.pulse()`)
  await query('PulseNeedle')
  await evaluate(`window.searchFixture.ask()`)
  await query('PendingNeedle')
  await query('PendingOptionNeedle')
  await evaluate(`window.searchFixture.answer()`)
  await query('AnsweredAsyncNeedle')
  await evaluate(`window.searchFixture.append(' DuplicateNeedle DuplicateNeedle')`)
  await query('DuplicateNeedle')
  await evaluate(
    `document.querySelector('.search-bar button[aria-label="下一处（Enter）"]').click()`,
  )
  await until(
    () => evaluate(`document.querySelector('.search-count').textContent==='2 / 2'`),
    '下一处',
  )
  await evaluate(
    `document.querySelector('.search-bar input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}))`,
  )
  await until(
    () => evaluate(`document.querySelector('.search-count').textContent==='1 / 2'`),
    'Shift+Enter 上一处',
  )
  report.checks.push({ name: '命中上下跳转' })
  // 搜索 Worker 正在处理一万条目时，主线程仍可响应输入与下一帧。
  const inputMs = await evaluate(
    `new Promise(resolve=>{const start=performance.now();const input=document.querySelector('.search-bar input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'容量文本');input.dispatchEvent(new Event('input',{bubbles:true}));requestAnimationFrame(()=>resolve(performance.now()-start));})`,
  )
  assert.ok(inputMs < 100, `输入响应 ${inputMs}ms`)
  report.checks.push({ name: '10000 条目输入到下一帧', ms: inputMs })
  await query('ThoughtNeedle')
  await evaluate(
    `document.querySelector('.search-bar input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  )
  await until(
    () =>
      evaluate(
        `!document.querySelector('.search-bar') && !CSS.highlights.has('litch-find-current')`,
      ),
    'Esc 关闭并清除高亮',
  )
  assert.equal(
    await evaluate(`!!document.querySelector('[data-search-item="t0:thought"] .item-detail')`),
    false,
  )
  report.checks.push({ name: '退出恢复思考折叠' })
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',key:'f',metaKey:true,bubbles:true}))`,
  )
  await until(() => evaluate(`!!document.querySelector('.search-bar input')`), 'Ctrl+F')
  await evaluate(
    `document.querySelector('.search-bar input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',key:'f',metaKey:true,shiftKey:true,bubbles:true}))`,
  )
  await until(() => evaluate(`!!document.querySelector('.search-dialog[open]')`), '全局搜索')
  await evaluate(
    `(()=>{const input=document.querySelector('.search-dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'rust');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  )
  await until(
    () => evaluate(`document.querySelector('.search-results')?.textContent.includes('已归档')`),
    '默认包含归档标题',
  )
  report.checks.push({
    name: '跨设备全局入口与归档标题',
    status: await evaluate(`document.querySelector('.search-coverage').textContent`),
  })
  await evaluate(`window.__litchLook?.set({skin:'standard',theme:'light'})`)
  await cdp
    .call('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(join(output, 'titles.png'), Buffer.from(r.data, 'base64')))
  await checkSearchReview({ cdp, evaluate, query, report, output, base })
  await checkSearchR3({ cdp, evaluate, query, report, output, base })
  assert.deepEqual(errors, [])
  report.success = true
} catch (error) {
  report.error = String(error)
  if (cdp) {
    report.debug = await cdp.call('Runtime.evaluate', {
      expression: `(()=>{const s=document.querySelector('.tr-scroll');const r=[...(CSS.highlights.get('litch-find-current')??[])][0];return {scroll:s?{top:s.scrollTop,height:s.clientHeight,total:s.scrollHeight}:null,rect:r?.getBoundingClientRect().toJSON(),body:document.body.getBoundingClientRect().toJSON(),html:document.querySelector('.search-bar')?.textContent}})()`,
      returnByValue: true,
    })
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, 'failure.png'), Buffer.from(shot.data, 'base64'))
  }
  throw error
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputBase, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(output, 'browser.log'), log)
  cdp?.close()
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  vite?.kill('SIGTERM')
  if (report.success) rmSync(work, { recursive: true, force: true })
  // 失败时保留仅含假会话的隔离 profile 便于诊断，不触碰用户浏览器。
}
console.log(JSON.stringify(report, null, 2))
