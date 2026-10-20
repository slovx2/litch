// 自动填充、“代理读不到密码”、登录后的保存提示的真实窗口自检（scripts/check-browser.mjs --autofill 打包后起）：
// 真的宿主、真的自动填充预加载和主进程接线、真的 safeStorage（应用名改成测试专用的，钥匙串里那一条用完由
// check-browser.mjs 删掉），窗口显示在屏幕上。测试登录页在回环上：主页面 http://127.0.0.1:A，里面嵌一个
// 跨源子框架（端口 B），各有一个登录表单。
//
// 默认（自动）：Menu.prototype.popup 换成桩，记下菜单里有什么、按要求点哪一条，不弹真的原生菜单；
// 用户点框用 webContents.sendInputEvent（受信任的输入事件）。
// 加 --manual：不换桩，弹真的原生菜单，打出用户名框在屏幕上的坐标，等人（或 Peekaboo）去点，填上了就结束。
// 结果打一行 LITCH_BROWSER {ok, checks}。
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import { createBrowserExecutor } from './browser/executor.mjs'
import { installPasswords } from './browser/passwords/install.mjs'
import { PASSWORDS_PROMPTS_CHANGED } from './browser/passwords/ipc.mjs'
import { autofillTab } from './browser/passwords/tabs.mjs'
import { createSiteBook } from './browser/sites.mjs'
import type { ClientToolInvocation } from './client-tools/types.mjs'
import { CHANGE, checkCaptures, FORGED, STEP2 } from './probe-browser-autofill-capture.mjs'

const manual = process.env.LITCH_AUTOFILL_MANUAL === '1'
// 钥匙串里那把钥匙按应用名起名：用测试专用的名字，不碰 Litch 自己的
app.setName('Litch Autofill Probe')
if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)

interface Check {
  name: string
  ok: boolean
  detail?: unknown
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(ok ? {} : { detail }) })
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const LOGIN = (frameUrl: string) => `<!doctype html><title>Sign in</title>
<form id="f" method="post" action="/welcome" style="margin:20px"><input id="user" type="email" autocomplete="username" style="display:block;width:240px;height:28px">
<input id="pass" type="password" style="display:block;width:240px;height:28px;margin-top:8px"><button>Sign in</button></form>
<iframe id="sub" src="${frameUrl}" style="width:420px;height:160px;border:1px solid #888;margin:20px"></iframe>
<script>
window.__events = []
for (const id of ['user', 'pass']) document.getElementById(id).addEventListener('input', () => __events.push(id))
window.__exposed = Object.keys(window).filter((key) => /litch|ipc|electron|autofill|require|process/i.test(key))
  .concat([typeof require, typeof process, typeof module])
window.__forge = () => {
  const user = document.getElementById('user')
  user.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
  user.focus()
  user.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
}
</script>`

const FRAME = `<!doctype html><form action="/frame-done" style="margin:10px"><input id="user" name="u" type="text" style="width:200px;height:24px">
<input id="pass" name="p" type="password" style="width:200px;height:24px"><button id="go">Go</button></form>`

function serve(body: (path: string) => string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      // 登录表单提交（POST）：读完请求、回一页“登进来了”，算一次导航完成
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          request.method === 'POST'
            ? '<!doctype html><title>Welcome</title><p>Signed in</p>'
            : body(request.url ?? '/'),
        )
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    )
  })
}

void app.whenReady().then(async () => {
  const limit = setTimeout(
    () => {
      console.log(`LITCH_BROWSER ${JSON.stringify({ ok: false, checks, error: '超时' })}`)
      app.exit(1)
    },
    manual ? 220_000 : 100_000,
  )
  const frameSite = await serve(() => FRAME)
  // 自动的那一遍子框架和主页面同站不同源（端口不同）：合成的输入事件只进主框架所在的进程，跨站的子框架
  // 在别的进程里收不到（实测）。手动的那一遍用 localhost，跨站、在别的进程里，真人去点
  const frameUrl = `http://${manual ? 'localhost' : '127.0.0.1'}:${frameSite.port}/frame`
  const mainSite = await serve((path) =>
    path.startsWith('/step2')
      ? STEP2
      : path.startsWith('/change')
        ? CHANGE
        : path.startsWith('/forged')
          ? FORGED
          : LOGIN(frameUrl),
  )
  const pageUrl = `http://127.0.0.1:${mainSite.port}/login`
  const pageOrigin = `http://127.0.0.1:${mainSite.port}`
  const frameOrigin = new URL(frameUrl).origin

  const work = mkdtempSync(join(tmpdir(), 'litch-autofill-probe-'))
  // 推给界面的保存提示记下来（这里没有界面）
  const pushedPrompts: unknown[] = []
  const passwords = installPasswords({
    userData: work,
    fromUi: () => false,
    broadcast: (channel, payload) => {
      if (channel === PASSWORDS_PROMPTS_CHANGED) pushedPrompts.push(payload)
    },
  })
  const seeded = await passwords.importMany(
    [
      { origin: pageOrigin, username: 'ann@example.com', password: 'ann-pass-1', store: 'profile' },
      { origin: pageOrigin, username: 'bob@example.com', password: 'bob-pass-2', store: 'profile' },
      { origin: frameOrigin, username: 'frame-user', password: 'frame-pass-3', store: 'profile' },
      { origin: 'https://elsewhere.example', username: 'x', password: 'x-pass', store: 'profile' },
    ],
    'chrome:Default',
  )
  check('导入四条', seeded.imported === 4, seeded)

  // 菜单的桩：记下有什么，按 pick 点那一条（候选从第三项起：头两项是标题和分隔线）
  const popups: string[][] = []
  let pick: number | null = null
  if (!manual) {
    Menu.prototype.popup = function (this: Menu, options) {
      popups.push(this.items.map((item) => item.label))
      const item = pick === null ? undefined : this.items[2 + pick]
      if (item) item.click()
      options?.callback?.()
    }
  }

  const window = new BrowserWindow({ width: 900, height: 640, show: true, title: 'Autofill probe' })
  await window.loadURL('data:text/html,<body style="margin:0;background:#eee"></body>')
  const host = createElectronHost()
  const owner = { deviceId: 'local', threadId: 'thread-a' }
  const user = host.openForUser(owner, pageUrl)
  const userTab = host.page(user.id) as HostTab
  const [width, height] = window.getContentSize()
  host.place(window, user.id, { x: 0, y: 0, width: width ?? 900, height: height ?? 640 })
  await userTab.waitForLoad(10_000, new AbortController().signal)
  await sleep(500)
  const contents = userTab.view.webContents
  const main = (code: string) => contents.executeJavaScript(code)
  const sub = () => contents.mainFrame.frames[0]

  check('用户标签挂了预加载', autofillTab(contents.id)?.kind === 'user')
  check(
    '网页看不到预加载暴露的任何东西（全局变量、require、process）',
    JSON.stringify(await main('window.__exposed')) ===
      JSON.stringify(['undefined', 'undefined', 'undefined']),
    await main('window.__exposed'),
  )

  /** 点一下（受信任的输入事件），坐标是视图里的 CSS 像素 */
  const clickAt = async (x: number, y: number) => {
    // 窗口不在前台时网页拿不到焦点、不发 focusin（真人点的时候窗口自然在前台）
    app.focus({ steal: true })
    window.focus()
    contents.focus()
    contents.sendInputEvent({ type: 'mouseMove', x, y })
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(600)
  }
  const centerOf = async (selector: string) =>
    (await main(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`,
    )) as [number, number]
  const values = () => main(`[user.value, pass.value, window.__events.join(',')]`)

  if (manual) {
    // 要点的地方打成屏幕坐标，等到填上（或者到点）
    const waitFilled = async (
      where: [number, number],
      label: string,
      read: () => Promise<unknown>,
    ): Promise<string[] | null> => {
      const bounds = window.getContentBounds()
      console.log(
        `LITCH_AUTOFILL_CLICK ${JSON.stringify({ label, x: Math.round(bounds.x + where[0]), y: Math.round(bounds.y + where[1]), pid: process.pid })}`,
      )
      const until = Date.now() + 90_000
      while (Date.now() < until) {
        const now = (await read()) as string[]
        if (now[1] !== '') return now
        await sleep(500)
      }
      return null
    }
    const filled = await waitFilled(await centerOf('#user'), 'main', values)
    check(
      '真的原生菜单里点选之后填上',
      !!filled && filled[1] !== '' && String(filled[0]).endsWith('@example.com'),
      filled,
    )
    const frame = sub()
    const inner = (await frame?.executeJavaScript(
      `(() => { const r = document.querySelector('#user').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`,
    )) as [number, number]
    const box = (await main(
      `(() => { const r = document.querySelector('#sub').getBoundingClientRect(); return [r.left + 1, r.top + 1] })()`,
    )) as [number, number]
    const inFrame = await waitFilled([box[0] + inner[0], box[1] + inner[1]], 'frame', async () =>
      frame?.executeJavaScript('[user.value, pass.value]'),
    )
    check(
      '跨站子框架（别的进程）里点选之后按它自己的源填上',
      JSON.stringify(inFrame) === JSON.stringify(['frame-user', 'frame-pass-3']),
      inFrame,
    )
  } else {
    // 网页自己造的事件（加上 focus() 引起的焦点事件）弹不出菜单
    await main('window.__forge()')
    await sleep(800)
    check('网页造的事件弹不出菜单', popups.length === 0, popups)
    await main('document.activeElement.blur()')

    // 用户点用户名框：菜单里是这个源的两条，点第二条，两个框都填上
    pick = 1
    await clickAt(...(await centerOf('#user')))
    check(
      '点用户名框弹出这个源的候选',
      JSON.stringify(popups[0]) ===
        JSON.stringify(['Litch saved passwords', '', 'ann@example.com', 'bob@example.com']) ||
        JSON.stringify(popups[0]) ===
          JSON.stringify(['Litch 已保存的密码', '', 'ann@example.com', 'bob@example.com']),
      popups,
    )
    const filled = (await values()) as string[]
    check(
      '点选之后两个框都填上、网页收到 input',
      filled[0] === 'bob@example.com' && filled[1] === 'bob-pass-2' && filled[2] === 'user,pass',
      filled,
    )

    // 跨源子框架按它自己的源
    const frame = sub()
    const inner = (await frame?.executeJavaScript(
      `(() => { const r = document.querySelector('#pass').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`,
    )) as [number, number] | undefined
    const box = (await main(
      `(() => { const r = document.querySelector('#sub').getBoundingClientRect(); return [r.left + 1, r.top + 1] })()`,
    )) as [number, number]
    pick = 0
    if (inner) await clickAt(box[0] + inner[0], box[1] + inner[1])
    check(
      '子框架只给它自己的源的候选',
      JSON.stringify(popups[1]?.slice(2)) === JSON.stringify(['frame-user']),
      popups,
    )
    const frameValues = await frame?.executeJavaScript('[user.value, pass.value]')
    check(
      '子框架里填上',
      JSON.stringify(frameValues) === JSON.stringify(['frame-user', 'frame-pass-3']),
      frameValues,
    )
    const mainAfter = (await values()) as string[]
    check('子框架的密码没进主页面', mainAfter[1] === 'bob-pass-2', mainAfter)

    // 认登录提交：两步登录、改密码、只在子框架里登录、网页造的提交（probe-browser-autofill-capture.mts）
    pick = null
    await checkCaptures({ window, host, owner, pageOrigin, frameOrigin, pushedPrompts, check })
  }

  // 代理的标签：代理用 click 点用户名框，候选画在网页里（封闭的影子树），代理在快照里看得到、点中一条才填；
  // 工具结果里从不出现密码；代理输入新的用户名密码再点登录，导航完成后只给界面推一条保存提示
  const sites = createSiteBook(join(work, 'sites.json'))
  const executor = createBrowserExecutor({ host, sites, resolveUrl: (url) => url })
  let seq = 0
  const results: string[] = []
  const textOf = (reply: ClientToolCallResponse) =>
    reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')
  const run = async (tool: string, args: Record<string, unknown> = {}) => {
    const invocation: ClientToolInvocation = {
      id: `call-${++seq}`,
      threadId: 'thread-a',
      turnId: 'turn-1',
      callId: `c${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: { id: 'local', name: '本机', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
    }
    const text = textOf(
      await executor.call(invocation, {
        signal: new AbortController().signal,
        ask: async () => null,
      }),
    )
    results.push(text)
    return text
  }
  const refOf = (snapshot: string, pattern: RegExp) =>
    /\[ref=(e\d+)\]/.exec(snapshot.split('\n').find((line) => pattern.test(line)) ?? '')?.[1] ?? ''
  await run('navigate', { url: pageUrl, newTab: true })
  const agentTab = host.pages().find((page) => page.info().kind === 'agent') as HostTab | undefined
  const agentContents = agentTab?.view.webContents
  check(
    '代理的标签也挂了预加载',
    !!agentContents && autofillTab(agentContents.id)?.kind === 'agent',
  )
  host.place(window, agentTab?.id ?? null, {
    x: 0,
    y: 0,
    width: width ?? 900,
    height: height ?? 640,
  })
  const inAgent = (code: string) => agentContents?.executeJavaScript(code)

  // 网页自己造的事件画不出候选
  await inAgent('window.__forge()')
  await sleep(800)
  check(
    '网页造的事件在代理的标签里也弄不出候选',
    !(await inAgent(`!!document.querySelector('litch-autofill')`)),
  )
  await inAgent('document.activeElement.blur()')

  const first = await run('snapshot')
  await run('click', { ref: refOf(first, /textbox/) })
  await sleep(600)
  const listed = await run('snapshot')
  check(
    '代理点了用户名框，快照里看得到 Litch 的候选（只有用户名）',
    /Litch (saved passwords|已保存的密码)/.test(listed) &&
      /button "ann@example.com"/.test(listed) &&
      /button "bob@example.com"/.test(listed),
    listed,
  )
  check(
    '网页脚本读不进候选',
    (await inAgent(
      `(() => { const host = document.querySelector('litch-autofill'); return !!host && host.shadowRoot === null && !document.documentElement.innerText.includes('bob@example.com') })()`,
    )) === true,
  )
  // 网页看得出宿主元素在（这一条是实情，不是要的），但 window.find、全选之后的选区都读不到用户名和标题
  const seen = (await inAgent(
    `(() => {
      document.activeElement?.blur()
      const found = ['bob@example.com', 'ann@example.com', 'Litch'].filter((word) => { getSelection().removeAllRanges(); return window.find(word) })
      getSelection().removeAllRanges()
      document.execCommand('selectAll')
      const selected = getSelection().toString()
      getSelection().removeAllRanges()
      return { found, selected: /bob@example|ann@example|Litch/.test(selected), host: !!document.querySelector('litch-autofill') }
    })()`,
  )) as { found: string[]; selected: boolean; host: boolean } | undefined
  check(
    '网页的 window.find、全选的 getSelection 读不到候选里的字',
    !!seen && seen.found.length === 0 && !seen.selected && seen.host,
    seen,
  )
  check(
    '工具结果里提示代理去点候选',
    results.some((text) => text.includes('Litch listed saved sign-ins')),
    results,
  )
  await run('click', { ref: refOf(listed, /button "bob@example\.com"/) })
  await sleep(600)
  const agentFilled = await inAgent('[user.value, pass.value]')
  check(
    '代理点中一条之后填上',
    JSON.stringify(agentFilled) === JSON.stringify(['bob@example.com', 'bob-pass-2']),
    agentFilled,
  )

  // 读页工具读不到密码框里的值
  const snapAfter = await run('snapshot')
  check(
    '快照里遮住密码框',
    !snapAfter.includes('bob-pass-2') && /textbox[^\n]*••••••/.test(snapAfter),
    snapAfter,
  )
  const evaluated = await run('evaluate', {
    expression: `({ a: document.querySelector('#pass').value, b: [...document.querySelectorAll('input')].map((one) => one.value) })`,
  })
  check('evaluate 的结果里替掉密码框的值', !evaluated.includes('bob-pass-2'), evaluated)
  const cleared = await run('evaluate', {
    expression: `(() => { const one = document.querySelector('#pass'); const v = one.value; one.value = ''; return v })()`,
  })
  check('先读再清空也替掉', !cleared.includes('bob-pass-2'), cleared)

  // 代理输入新的一组再点登录：导航完成后推一条“保存”提示，里面没有密码
  const fresh = await run('snapshot')
  const boxes = [...fresh.matchAll(/textbox[^\n]*\[ref=(e\d+)\]/g)].map((match) => match[1])
  await run('type', { ref: boxes[0], text: 'carol@example.com', clear: true })
  const typed = await run('type', { ref: boxes[1], text: 'carol-pass-9', clear: true })
  check('type 不回报密码框的值', !typed.includes('carol-pass-9'), typed)
  await run('click', { ref: refOf(fresh, /button "Sign in"/) })
  await agentTab?.waitForLoad(10_000, new AbortController().signal)
  await sleep(800)
  const latest = pushedPrompts.at(-1) as Array<Record<string, unknown>> | undefined
  check(
    '登录导航完成后给界面推了一条保存提示',
    !!latest &&
      latest.length === 1 &&
      latest[0]?.kind === 'save' &&
      latest[0]?.username === 'carol@example.com' &&
      latest[0]?.origin === pageOrigin &&
      latest[0]?.tabId === agentTab?.id,
    pushedPrompts,
  )
  check('保存提示里没有密码', !JSON.stringify(pushedPrompts).includes('carol-pass-9'))
  check('没人答之前没有存', passwords.list().length === 4, passwords.list().length)
  check(
    '工具结果里从不出现密码、也不提保存提示',
    results.every(
      (text) =>
        !/bob-pass-2|ann-pass-1|carol-pass-9/.test(text) && !/save (this )?password/i.test(text),
    ),
    results,
  )

  // 清除浏览数据不碰密码
  await host.clearData()
  check('清除浏览数据之后密码还在', passwords.list().length === 4, passwords.list().length)

  clearTimeout(limit)
  for (const page of host.pages()) host.close(page.id)
  mainSite.server.close()
  frameSite.server.close()
  rmSync(work, { recursive: true, force: true })
  const ok = checks.every((one) => one.ok)
  console.log(
    `LITCH_BROWSER ${JSON.stringify({ ok, passed: checks.filter((one) => one.ok).length, checks: checks.filter((one) => !one.ok || process.env.LITCH_VERBOSE) })}`,
  )
  app.exit(ok ? 0 : 1)
})
