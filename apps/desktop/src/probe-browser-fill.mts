// Litch 代填（request_sign_in 的方案 B）的真实窗口自检（scripts/check-browser.mjs --fill 打包后起）：
// 真的宿主、真的预加载和主进程接线、真的观察闸；密码库用临时目录里的、加密器是假的（不碰钥匙串）。
// 窗口显示在屏幕上（真的点击、按键要窗口在前台）。测试网页在回环上（probe-browser-fill-pages.mts）。
// 泄露用例逐条：执行过脚本的页面、“显示密码”的按钮当提交、GET 表单、单页应用不换文档、页面把密码打进控制台、
// 改标题、弹框带密码、OAuth 弹窗、编号指向搜索框、两步登录、验证码页。每一条都查：代理拿到的所有工具结果里
// 没有那串密码，代填的提交不出保存提示，服务器收到的是对的账号。
// 结果打一行 LITCH_BROWSER {ok, checks}。
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import { createBrowserExecutor } from './browser/executor.mjs'
import { installAutofill } from './browser/passwords/autofill.mjs'
import { createHandover } from './browser/passwords/handover.mjs'
import { createSavePrompts } from './browser/passwords/prompts.mjs'
import { createSignIns, type SignInRequest } from './browser/passwords/signin.mjs'
import { createPasswordStore } from './browser/passwords/store.mjs'
import { createSiteBook } from './browser/sites.mjs'
import type { ClientToolAsk, ClientToolInvocation } from './client-tools/types.mjs'
import { runCases } from './probe-browser-fill-cases.mjs'
import * as PAGES from './probe-browser-fill-pages.mjs'

if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)

const PASSWORD = 'Fill-Secret-42!'
const USERNAME = 'agent-user@example.com'

interface Check {
  name: string
  ok: boolean
  detail?: unknown
}
const checks: Check[] = []
/** 超时时一起打出来：卡在哪一步 */
const trace: string[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(ok ? {} : { detail }) })
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 测试网页：GET 按路径给页面，POST 记下交上来的东西再给下一页 */
function serve(): Promise<{
  server: Server
  port: number
  posts: Array<{ path: string; body: string }>
}> {
  const posts: Array<{ path: string; body: string }> = []
  const pages: Record<string, string> = {
    '/plain': PAGES.PLAIN,
    '/get': PAGES.GET_FORM,
    '/search': PAGES.SEARCH,
    '/step1': PAGES.STEP1,
    '/otp-login': PAGES.OTP_LOGIN,
    '/spa': PAGES.SPA,
    '/scripted': PAGES.SPA,
    '/spa-console': PAGES.SPA_CONSOLE,
    '/spa-title': PAGES.SPA_TITLE,
    '/spa-alert': PAGES.SPA_ALERT,
    '/spa-popup': PAGES.SPA_POPUP,
    '/spa-show': PAGES.SPA_SHOW,
    '/oauth': PAGES.WELCOME,
  }
  const after: Record<string, string> = { '/step2': PAGES.STEP2, '/otp': PAGES.OTP }
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/'
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        if (request.method === 'POST') posts.push({ path, body })
        const page =
          request.method === 'POST'
            ? path === '/api/login'
              ? 'ok'
              : (after[path] ?? PAGES.WELCOME)
            : (pages[path] ?? PAGES.WELCOME)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(page)
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, posts }),
    )
  })
}

void app.whenReady().then(async () => {
  const limit = setTimeout(() => {
    console.log(`LITCH_BROWSER ${JSON.stringify({ ok: false, checks, trace, error: '超时' })}`)
    app.exit(1)
  }, 200_000)
  const site = await serve()
  const base = `http://127.0.0.1:${site.port}`
  const work = mkdtempSync(join(tmpdir(), 'litch-fill-probe-'))
  // 假的加密器：明文加个前缀（不碰钥匙串）
  const store = createPasswordStore({
    file: join(work, 'passwords.json'),
    cipher: {
      available: () => true,
      encrypt: (plain) => `x:${plain}`,
      decrypt: (sealed) => sealed.slice(2),
    },
    log: () => {},
  })
  await store.importMany(
    [{ origin: base, username: USERNAME, password: PASSWORD, store: 'profile' }],
    'chrome:Default',
  )
  const prompts = createSavePrompts({ store })
  const pushedPrompts: unknown[] = []
  prompts.onChange((list) => pushedPrompts.push(list))
  installAutofill(store, prompts)

  const window = new BrowserWindow({ width: 900, height: 640, show: true, title: 'Fill probe' })
  await window.loadURL('data:text/html,<body style="margin:0;background:#eee"></body>')
  const host = createElectronHost()
  const signIns = createSignIns()
  const grants = new Map<string, string>()
  const executor = createBrowserExecutor({
    host,
    sites: createSiteBook(join(work, 'sites.json')),
    resolveUrl: (url) => url,
    handover: createHandover({
      host,
      signIns,
      store: () => store,
      log: () => {},
      // 定时任务的事先授权：自检里放在内存里
      preauthorized: ({ deviceId, taskId, origin }) =>
        grants.get(`${deviceId}|${taskId}|${origin}`) ?? null,
      remember: ({ deviceId, taskId, origin, entryId }) =>
        void grants.set(`${deviceId}|${taskId}|${origin}`, entryId),
    }),
  })

  let seq = 0
  /** 代理拿到的所有工具结果：最后查一遍里面没有密码 */
  const results: string[] = []
  const signInResults: string[] = []
  const shown: ClientToolAsk[] = []
  const textOf = (reply: ClientToolCallResponse) =>
    reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')
  /** 这一回合是哪个定时任务跑的（核心按运行记录填的那个字段） */
  let task: { id: string; name: string } | null = null
  const call = (tool: string, args: Record<string, unknown> = {}, turnId = 'turn-1') => {
    const invocation: ClientToolInvocation = {
      id: `call-${++seq}`,
      threadId: 'thread-a',
      turnId,
      callId: `c${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: { id: 'local', name: '本机', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
      task,
    }
    return executor
      .call(invocation, {
        signal: new AbortController().signal,
        ask: async () => null,
        show(ask) {
          shown.push(ask)
          return () => {}
        },
      })
      .then((reply) => {
        trace.push(`${tool}: ${textOf(reply).slice(0, 160)}`)
        results.push(textOf(reply))
        if (tool === 'request_sign_in') signInResults.push(textOf(reply))
        return reply
      })
  }
  const run = async (tool: string, args: Record<string, unknown> = {}, turnId?: string) =>
    textOf(await call(tool, args, turnId))
  const refOf = (snapshot: string, pattern: RegExp) =>
    /\[ref=(e\d+)\]/.exec(snapshot.split('\n').find((line) => pattern.test(line)) ?? '')?.[1] ?? ''
  const waitFor = async <T,>(get: () => T | undefined | null, ms = 8000): Promise<T | null> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const got = get()
      if (got) return got
      await sleep(100)
    }
    return get() ?? null
  }
  const current = () =>
    host.page(executor.currentTab('local', 'thread-a') ?? '') as HostTab | undefined
  /** 代理的标签显示在窗口里、窗口在前台（真的按键、点击要它） */
  const place = (tab: HostTab) => {
    const [width, height] = window.getContentSize()
    host.place(window, tab.id, { x: 0, y: 0, width: width ?? 900, height: height ?? 640 })
    app.focus({ steal: true })
    window.focus()
  }

  /** 代理开一页（新标签），显示在窗口里 */
  const open = async (path: string) => {
    await run('navigate', { url: `${base}${path}`, newTab: true })
    const tab = current()
    if (tab) place(tab)
    await sleep(200)
    return tab
  }
  /** 在当前标签上请登录、等卡片；answer 给了就照它答。回卡片和给代理的结果 */
  const request = async (
    options: {
      args?: Record<string, unknown>
      /** 怎么答；给函数的自己答（必须答，不然一直等） */
      answer?: 'fill' | 'cancel' | ((card: SignInRequest) => void | Promise<void>)
      turn?: string
      /** 代填时勾“以后直接用这个账号” */
      remember?: boolean
    } = {},
  ): Promise<{ card: SignInRequest | null; text: string }> => {
    const pending = run('request_sign_in', { reason: 'Probe.', ...options.args }, options.turn)
    const card = await waitFor(() =>
      signIns.list().find((one) => one.state === 'waiting' && one.stage === 'choose'),
    )
    trace.push(`card: ${JSON.stringify(card ?? signIns.list()).slice(0, 300)}`)
    if (card && options.answer === 'fill') {
      // 答不了（预检不过）就拒绝，免得一直等
      const fill = { fill: card.accounts[0]?.ref ?? '', remember: options.remember === true }
      if (!signIns.answer(card.id, fill)) {
        trace.push('fill refused')
        signIns.answer(card.id, 'cancel')
      }
    } else if (card && options.answer === 'cancel') signIns.answer(card.id, 'cancel')
    else if (card && typeof options.answer === 'function') await options.answer(card)
    return { card, text: await pending }
  }
  const postsTo = (path: string) => site.posts.filter((one) => one.path === path)

  await runCases({
    open,
    request,
    run,
    refOf,
    current,
    waitFor,
    postsTo,
    pushedPrompts,
    shown,
    signIns,
    host,
    check,
    base,
    password: PASSWORD,
    username: USERNAME,
    setTask: (next) => {
      task = next
    },
    grants,
  })

  check(
    '代理拿到的所有工具结果里都没有那串密码',
    !results.some((text) => text.includes(PASSWORD)),
    results.filter((text) => text.includes(PASSWORD)),
  )
  // 用户名框里的字代理读得到（那是页面本身），request_sign_in 的结果里不给
  check(
    'request_sign_in 的结果里没有用户名',
    !signInResults.some((text) => text.includes(USERNAME)),
    signInResults,
  )

  clearTimeout(limit)
  for (const page of host.pages()) host.close(page.id)
  site.server.close()
  rmSync(work, { recursive: true, force: true })
  const ok = checks.every((one) => one.ok)
  console.log(
    `LITCH_BROWSER ${JSON.stringify({ ok, passed: checks.filter((one) => one.ok).length, checks: checks.filter((one) => !one.ok || process.env.LITCH_VERBOSE) })}`,
  )
  app.exit(ok ? 0 : 1)
})
