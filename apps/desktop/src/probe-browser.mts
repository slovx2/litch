// 内置浏览器的自检（scripts/check-browser.mjs 打包后起，窗口不显示）：真的宿主（WebContentsView + CDP）、
// 真的执行器，ask 用桩。测试网页在回环上（probe-browser-pages.mts），要审批的来源靠 host-resolver-rules
// 解析到回环，不出网。逐个工具调用并断言，另外专门量三件事：CDP 白名单、按来源审批、回合收尾。
// 结果打一行 LITCH_BROWSER {ok, checks}。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import { BROWSER_SCREENSHOT_MAX_EDGE } from '../../../packages/protocol/src/client-tools-browser.mjs'
import { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import { createBrowserExecutor } from './browser/executor.mjs'
import { imageSize } from './browser/page-ops.mjs'
import { createSiteBook } from './browser/sites.mjs'
import type {
  ClientToolAnswer,
  ClientToolAsk,
  ClientToolInvocation,
} from './client-tools/types.mjs'
import { startPages } from './probe-browser-pages.mjs'

if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)
// 两个“外面的”来源其实在回环上：不出网也能试审批
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.example 127.0.0.1')

interface Check {
  name: string
  ok: boolean
  detail?: unknown
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(ok ? {} : { detail }) })
}
const textOf = (reply: ClientToolCallResponse) =>
  reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')
const refOf = (snapshot: string, pattern: RegExp): string => {
  const line = snapshot.split('\n').find((one) => pattern.test(one)) ?? ''
  return /\[ref=(e\d+)\]/.exec(line)?.[1] ?? ''
}

void app.whenReady().then(async () => {
  app.dock?.hide()
  const limit = setTimeout(() => {
    console.log(`LITCH_BROWSER ${JSON.stringify({ ok: false, checks, error: '超时' })}`)
    app.exit(1)
  }, 200_000)
  const pages = await startPages()
  const work = mkdtempSync(join(tmpdir(), 'litch-browser-probe-'))
  const host = createElectronHost()
  const sites = createSiteBook(join(work, 'sites.json'))
  const executor = createBrowserExecutor({ host, sites, resolveUrl: (url) => url })
  const shows: string[] = []
  host.onShow((tab) => shows.push(tab.id))

  // ask 的桩：按队列答，记下问了什么
  const asked: ClientToolAsk[] = []
  let answers: Array<ClientToolAnswer | null> = []
  let turn = 1
  const device = { id: 'local', name: '本机', kind: 'local' as const, target: null }
  let seq = 0
  const run = async (
    tool: string,
    args: Record<string, unknown> = {},
    options: { threadId?: string; remote?: boolean } = {},
  ) => {
    const invocation: ClientToolInvocation = {
      id: `call-${++seq}`,
      threadId: options.threadId ?? 'thread-a',
      turnId: `turn-${turn}`,
      callId: `c${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: options.remote
        ? { id: 'build', name: 'build', kind: 'ssh', target: 'build' }
        : device,
      harness: 'pi',
      cwd: null,
    }
    return executor.call(invocation, {
      signal: new AbortController().signal,
      ask: async (ask) => {
        asked.push(ask)
        return answers.length > 0 ? (answers.shift() ?? null) : null
      },
    })
  }
  const endTurn = (threadId = 'thread-a') => {
    executor.turnEnded({ deviceId: 'local', threadId, turnId: `turn-${turn}` })
    turn++
  }
  const evalIn = async (expression: string) => textOf(await run('evaluate', { expression }))

  try {
    // ---------- 标签与导航（本机来源不审批） ----------
    let reply = await run('tabs', { action: 'list' })
    check('一开始没有标签', textOf(reply).includes('No tabs'), textOf(reply))
    reply = await run('navigate', { url: `${pages.local}/form` })
    check('本机地址直接打开、不问', reply.success && asked.length === 0, textOf(reply))
    const tabA = executor.currentTab('local', 'thread-a') ?? ''
    check('开了一个标签并成为当前的', tabA !== '')
    reply = await run('navigate', { url: 'localhost:1/x' })
    check('localhost 补成 http', textOf(reply).includes('http://localhost:1/x'), textOf(reply))
    await run('navigate', { url: `${pages.local}/form` })

    // ---------- 快照与操作 ----------
    reply = await run('snapshot')
    const snap = textOf(reply)
    const nameRef = refOf(snap, /textbox "Name"/)
    const colorRef = refOf(snap, /combobox "Color"/)
    const agreeRef = refOf(snap, /checkbox "Agree"/)
    const goRef = refOf(snap, /button "Submit"/)
    check(
      '快照里有带编号的输入框、下拉、勾选、按钮',
      !!(nameRef && colorRef && agreeRef && goRef),
      snap,
    )
    reply = await run('type', { ref: nameRef, text: 'Ada' })
    check('按编号输入', textOf(reply).includes('"Ada"'), textOf(reply))
    reply = await run('type', { ref: nameRef, text: 'Grace', clear: true })
    check('清空后输入', textOf(reply).includes('"Grace"'), textOf(reply))
    reply = await run('type', { ref: colorRef, text: 'Green' })
    check('下拉框按字选', textOf(reply).includes('Selected "Green"'), textOf(reply))
    await run('click', { ref: agreeRef })
    await run('click', { ref: goRef })
    reply = await run('snapshot', { diff: true })
    check(
      '提交之后快照差异里有结果',
      textOf(reply).includes('+ ') && textOf(reply).includes('submitted Grace|g|true'),
      textOf(reply),
    )

    // ---------- 截图与坐标 ----------
    reply = await run('screenshot')
    const image = reply.contentItems.find((item) => item.type === 'inputImage')
    const data = image && image.type === 'inputImage' ? image.imageUrl : ''
    const size = imageSize(Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    check(
      '截图是 JPEG 的 data 地址、最长边不超过上限',
      data.startsWith('data:image/jpeg;base64,') &&
        !!size &&
        Math.max(size.width, size.height) <= BROWSER_SCREENSHOT_MAX_EDGE,
      { size, head: data.slice(0, 40) },
    )
    const box = JSON.parse(
      await evalIn(
        "(() => { const r = document.getElementById('big').getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2, innerWidth]) })()",
      ),
    ) as string
    const [bx, by, cssWidth] = JSON.parse(box) as [number, number, number]
    const scale = (size?.width ?? cssWidth) / cssWidth
    reply = await run('click', { x: Math.round(bx * scale), y: Math.round(by * scale) })
    check('按截图坐标点', (await evalIn('document.title')).includes('coords'), {
      reply: textOf(reply),
      scale,
    })
    reply = await run('screenshot', { format: 'png' })
    check(
      'PNG 截图',
      reply.contentItems.some(
        (item) => item.type === 'inputImage' && item.imageUrl.startsWith('data:image/png;base64,'),
      ),
    )

    // ---------- 按键、滚动、等待、控制台、跑脚本 ----------
    await run('click', { ref: nameRef })
    await run('press', { key: 'End' })
    await run('press', { key: 'Backspace' })
    check(
      '按键',
      (await evalIn("document.getElementById('name').value")).includes('Grac'),
      await evalIn("document.getElementById('name').value"),
    )
    await run('navigate', { url: `${pages.local}/long` })
    reply = await run('scroll', { dy: 600 })
    check('滚动', /Page scroll is now 0,[1-9]/.test(textOf(reply)), textOf(reply))
    await run('navigate', { url: `${pages.local}/late` })
    reply = await run('wait', { for: 'selector', selector: '#late', timeoutMs: 5000 })
    check('等元素出现', textOf(reply).startsWith('Found'), textOf(reply))
    reply = await run('wait', { for: 'text', text: 'never-there', timeoutMs: 300 })
    check('等不到会说没等到', textOf(reply).startsWith('Not found'), textOf(reply))
    await run('navigate', { url: `${pages.local}/console` })
    reply = await run('console')
    const logs = textOf(reply)
    check('控制台消息', logs.includes('hello-console') && logs.includes('broken-console'), logs)
    reply = await run('console', { level: 'error' })
    check(
      '只看错误',
      textOf(reply).includes('broken-console') && !textOf(reply).includes('hello-console'),
      textOf(reply),
    )
    check('跑脚本', (await evalIn('1 + 1')).trim() === '2')
    check('脚本出错照实说', (await evalIn('nope()')).includes('threw'))

    // ---------- 上传 ----------
    const file = join(work, 'hello.txt')
    writeFileSync(file, 'hi')
    await run('navigate', { url: `${pages.local}/upload` })
    const uploadSnap = textOf(await run('snapshot'))
    const fileRef = refOf(uploadSnap, /button "File"/)
    reply = await run('upload', { ref: fileRef, paths: [file] })
    check(
      '上传文件',
      reply.success &&
        (await evalIn("document.getElementById('picked').textContent")).includes('hello.txt'),
      { reply: textOf(reply), uploadSnap },
    )
    reply = await run('upload', { ref: fileRef, paths: ['relative.txt'] })
    check(
      '相对路径不收',
      !reply.success && textOf(reply).startsWith('[litch:invalid]'),
      textOf(reply),
    )
    reply = await run(
      'upload',
      { ref: fileRef, paths: [file] },
      { remote: true, threadId: 'thread-r' },
    )
    check(
      '远程设备的会话不能上传',
      !reply.success && textOf(reply).startsWith('[litch:invalid]'),
      textOf(reply),
    )

    // ---------- 对话框 ----------
    await run('navigate', { url: `${pages.local}/dialog` })
    const dialogSnap = textOf(await run('snapshot'))
    reply = await run('click', { ref: refOf(dialogSnap, /button "Ask"/) })
    check('点了之后说对话框开着', textOf(reply).includes('confirm dialog is open'), textOf(reply))
    reply = await run('snapshot')
    check(
      '对话框开着时别的工具先让答它',
      textOf(reply).includes('Answer it with `dialog` first'),
      textOf(reply),
    )
    await run('dialog', { accept: true })
    const answered = await evalIn("document.getElementById('answer').textContent")
    check('答了 confirm', answered.includes('true'), answered)
    await run('click', { ref: refOf(dialogSnap, /button "Warn"/) })
    await run('dialog', { accept: true })
    check(
      '答了 alert',
      (await evalIn("document.getElementById('answer').textContent")).includes('alerted'),
    )

    // ---------- 框架 ----------
    await run('navigate', { url: `${pages.local}/frame` })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const frameSnap = textOf(await run('snapshot'))
    const innerRef = refOf(frameSnap, /button "Inner button"/)
    check('快照里有 iframe 里的按钮', innerRef !== '' && frameSnap.includes('- frame'), frameSnap)
    await run('click', { ref: innerRef })
    check('点 iframe 里的按钮', (await evalIn('document.title')).includes('inner clicked'))

    // ---------- 弹窗、权限、隔离 ----------
    await run('navigate', { url: `${pages.local}/popup` })
    reply = await run('click', {
      ref: refOf(textOf(await run('snapshot')), /button "Open window"/),
    })
    const listed = textOf(await run('tabs', { action: 'list' }))
    check(
      '新窗口改成同一会话的新标签',
      textOf(reply).includes('in a new tab') && (listed.match(/"tabId"/g) ?? []).length === 2,
      { reply: textOf(reply), listed },
    )
    await run('navigate', { url: `${pages.local}/perm` })
    await run('wait', { for: 'text', text: 'denied', timeoutMs: 3000 })
    check(
      '网页的权限请求被拒',
      (await evalIn("document.getElementById('state').textContent")).includes('denied'),
    )
    const exposed = await evalIn(
      'JSON.stringify([typeof window.litchShell, typeof window.litchBrowser, typeof require, typeof process])',
    )
    check(
      '网页里没有外壳的接口、没有 Node',
      exposed.includes('[\\"undefined\\",\\"undefined\\",\\"undefined\\",\\"undefined\\"]'),
      exposed,
    )
    reply = await run('navigate', { url: 'app://ui/index.html' })
    check(
      '不许开界面的地址',
      !reply.success && textOf(reply).startsWith('[litch:invalid]'),
      textOf(reply),
    )
    reply = await run('navigate', { url: 'file:///etc/hosts' })
    check('不许开本机文件', !reply.success && textOf(reply).includes('http.server'), textOf(reply))
    reply = await run('show')
    check('show 让界面打开面板', reply.success && shows.length === 1)

    // ---------- CDP 白名单 ----------
    const page = host.page(executor.currentTab('local', 'thread-a') ?? '') as HostTab
    const refused: string[] = []
    for (const method of [
      'Network.getCookies',
      'Target.createTarget',
      'Browser.close',
      'Input.dispatchTouchEvent',
      'Storage.clearDataForOrigin',
      'Fetch.enable',
    ]) {
      try {
        await page.cdp(method, {})
      } catch (error) {
        if ((error as Error).name === 'CdpRefused') refused.push(method)
      }
    }
    check('白名单外的 CDP 命令都被拒', refused.length === 6, refused)
    const allowed = await page.cdp<{ result: { value: number } }>('Runtime.evaluate', {
      expression: '40 + 2',
      returnByValue: true,
    })
    check('白名单里的照常', allowed.result.value === 42)

    // ---------- 用户的标签 ----------
    const userTab = host.openForUser({ deviceId: 'local', threadId: 'thread-a' }, `${pages.local}/`)
    reply = await run('click', { tabId: userTab.id, x: 1, y: 1 })
    check(
      '代理不能动用户的标签',
      !reply.success && textOf(reply).includes('belongs to the user'),
      textOf(reply),
    )
    check(
      '列出时能看到用户的标签',
      textOf(await run('tabs', { action: 'list' })).includes('"owner": "user"'),
    )
    reply = await run('tabs', { action: 'list' }, { threadId: 'thread-b' })
    check('别的会话看不到这个会话的标签', textOf(reply).includes('No tabs'), textOf(reply))

    // ---------- 按来源审批 ----------
    asked.length = 0
    answers = ['decline']
    reply = await run('navigate', { url: `${pages.site}/` })
    check(
      '外面的网站先问，拒绝了回 declined 并说不许绕路',
      asked.length === 1 &&
        asked[0]?.kind === 'site' &&
        (asked[0] as { origin: string }).origin === pages.site &&
        textOf(reply).startsWith('[litch:declined]') &&
        textOf(reply).includes('Do not try'),
      { asked, reply: textOf(reply) },
    )
    reply = await run('navigate', { url: `${pages.site}/` })
    check(
      '同一回合里拒绝过的不再问',
      asked.length === 1 && textOf(reply).startsWith('[litch:declined]'),
    )
    endTurn()
    answers = ['once']
    reply = await run('navigate', { url: `${pages.site}/link` })
    check('下一回合再问，答“这一次”就打开', asked.length === 2 && reply.success, textOf(reply))
    const linkSnap = textOf(await run('snapshot'))
    check('这一回合里接着读不再问', asked.length === 2, linkSnap)
    reply = await run('click', { ref: refOf(linkSnap, /link "Go elsewhere"/) })
    check(
      '页面上的链接去没审批的来源被拦下',
      textOf(reply).includes('not approved yet') && textOf(reply).includes(pages.site),
      textOf(reply),
    )
    answers = []
    reply = await run('navigate', { url: `${pages.site}/redirect` })
    check(
      '重定向去没审批的来源被拦下',
      textOf(reply).includes('A redirect to') &&
        !(host.page(executor.currentTab('local', 'thread-a') ?? '')?.info().url ?? '').includes(
          '/secret',
        ),
      textOf(reply),
    )
    endTurn()
    answers = ['session']
    reply = await run('navigate', { url: `${pages.site}/` })
    check(
      '“这一次”过了回合就不算了；答“本会话”',
      asked.length === 3 && reply.success,
      textOf(reply),
    )
    endTurn()
    reply = await run('navigate', { url: `${pages.site}/form` })
    check('本会话允许的下一回合不问', asked.length === 3 && reply.success)
    answers = ['always']
    reply = await run('navigate', { url: `${pages.other}/` }, { threadId: 'thread-b' })
    check(
      '答“一直允许”记下来',
      asked.length === 4 &&
        reply.success &&
        sites.saved().some((one) => one.origin === pages.other),
    )
    await run('navigate', { url: `${pages.other}/` }, { threadId: 'thread-c' })
    check('一直允许的别的会话也不问', asked.length === 4)
    check('删掉一直允许', sites.forget(pages.other) === 1 && sites.saved().length === 0)
    answers = [null]
    reply = await run('navigate', { url: `${pages.other}/` }, { threadId: 'thread-c' })
    check(
      '删了以后又问；没答就被取消回 failed',
      asked.length === 5 && textOf(reply).startsWith('[litch:failed]'),
      textOf(reply),
    )

    // ---------- 回合收尾 ----------
    const keepTab = textOf(await run('tabs', { action: 'new', url: `${pages.local}/`, keep: true }))
    const keptId = /Tab (t\d+)/.exec(keepTab)?.[1] ?? ''
    await run('snapshot')
    const kept = host.page(keptId) as HostTab
    check(
      '代理在用时调试器挂着、有记号',
      kept.view.webContents.debugger.isAttached() && kept.info().agentActive,
    )
    const before = host
      .pages()
      .filter(
        (one) => one.info().owner.threadId === 'thread-a' && one.info().kind === 'agent',
      ).length
    endTurn()
    const after = host.pages().filter((one) => one.info().owner.threadId === 'thread-a')
    check(
      '回合结束关掉临时标签，留下标了留给用户的和用户自己的',
      before >= 2 &&
        after.length === 2 &&
        after.some((one) => one.id === keptId) &&
        after.some((one) => one.id === userTab.id),
      { before, after: after.map((one) => one.info()) },
    )
    check(
      '回合结束断开调试器、撤掉记号',
      !kept.view.webContents.debugger.isAttached() && !kept.info().agentActive,
    )

    // ---------- 挂到窗口上显示、再摘下 ----------
    const window = new BrowserWindow({ width: 900, height: 600, show: false })
    await window.loadURL('about:blank')
    host.place(window, keptId, { x: 100, y: 0, width: 400, height: 300 })
    check('显示时挂在窗口上', window.contentView.children.includes(kept.view))
    host.place(window, null, null)
    check('收起时摘下来', !window.contentView.children.includes(kept.view))
    reply = await run('screenshot', { tabId: keptId })
    check(
      '摘下来的视图照样能截图',
      reply.success && reply.contentItems.some((item) => item.type === 'inputImage'),
      textOf(reply),
    )
    window.destroy()
  } catch (error) {
    check('没有意外出错', false, error instanceof Error ? error.stack : String(error))
  }
  clearTimeout(limit)
  pages.close()
  const ok = checks.every((one) => one.ok)
  console.log(
    `LITCH_BROWSER ${JSON.stringify({ ok, passed: checks.filter((one) => one.ok).length, checks: checks.filter((one) => !one.ok || process.env.LITCH_VERBOSE) })}`,
  )
  app.exit(ok ? 0 : 1)
})
