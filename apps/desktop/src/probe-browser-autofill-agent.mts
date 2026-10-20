// 自动填充真实窗口自检（probe-browser-autofill.mts）里代理标签那一段：代理不碰密码，要登录就交给人。
// - 代理点用户名框：没有候选（不弹菜单、网页里不多东西），工具结果里没有已保存的用户名；
// - 代理先 evaluate 往页面里塞一个监听，再调 request_sign_in：页面先重新载入（监听没了），面板那头出卡片；
// - 冻结期间代理的快照、截图、执行脚本、点、输入都被拒，标签自己的 CDP 也发不出去；
// - 人点用户名框（自动的那一遍用受信任的输入事件代替人）：弹原生菜单，选一条填上；子框架里也填一个密码；
// - 人点“完成，交还”：各框架的密码框都清空了，代理拿到“用户登录完了”，不带任何输入；之后代理照常能用；
// - 再交一次、人点取消：代理拿到“取消了”；
// - 代理自己输入新的一组、点登录：快照、type、evaluate 里都没有密码，导航完成后只给界面推一条保存提示。
import type { BrowserWindow } from 'electron'
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import type { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import type { BrowserExecutor } from './browser/executor.mjs'
import { SIGNING_IN } from './browser/executor.mjs'
import type { SignIns } from './browser/passwords/signin.mjs'
import { autofillTab } from './browser/passwords/tabs.mjs'
import type { ClientToolInvocation } from './client-tools/types.mjs'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function checkAgentSignIn(options: {
  window: BrowserWindow
  host: ReturnType<typeof createElectronHost>
  executor: BrowserExecutor
  signIns: SignIns
  pageUrl: string
  pageOrigin: string
  pushedPrompts: unknown[]
  popups: string[][]
  setPick(index: number | null): void
  storedCount(): number
  /** 手动的那一遍：不用合成的输入事件，打出坐标等人（或 Peekaboo）去点真的菜单 */
  manual: boolean
  check(name: string, ok: boolean, detail?: unknown): void
}): Promise<void> {
  const { window, host, executor, signIns, pageUrl, pageOrigin, pushedPrompts, popups, check } =
    options
  let seq = 0
  const results: string[] = []
  const textOf = (reply: ClientToolCallResponse) =>
    reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')
  const call = (tool: string, args: Record<string, unknown> = {}) => {
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
    return executor
      .call(invocation, { signal: new AbortController().signal, ask: async () => null })
      .then((reply) => {
        results.push(textOf(reply))
        return reply
      })
  }
  const run = async (tool: string, args: Record<string, unknown> = {}) =>
    textOf(await call(tool, args))
  const refOf = (snapshot: string, pattern: RegExp) =>
    /\[ref=(e\d+)\]/.exec(snapshot.split('\n').find((line) => pattern.test(line)) ?? '')?.[1] ?? ''
  const waitFor = async (test: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end && !test()) await sleep(100)
    return test()
  }

  await run('navigate', { url: pageUrl, newTab: true })
  const tab = host.pages().find((page) => page.info().kind === 'agent') as HostTab | undefined
  const contents = tab?.view.webContents
  check('代理的标签也挂了预加载', !!contents && autofillTab(contents.id)?.kind === 'agent')
  if (!tab || !contents) return
  const [width, height] = window.getContentSize()
  host.place(window, tab.id, { x: 0, y: 0, width: width ?? 900, height: height ?? 640 })
  const page = (code: string) => contents.executeJavaScript(code)

  // 代理点用户名框：没有候选
  const before = popups.length
  const first = await run('snapshot')
  await run('click', { ref: refOf(first, /textbox/) })
  await sleep(800)
  const after = await run('snapshot')
  check(
    '代理点了用户名框：不弹菜单、网页里不多东西、快照里没有已保存的用户名',
    popups.length === before &&
      (await page('document.documentElement.children.length')) === 2 &&
      !/ann@example|bob@example/.test(after),
    { popups: popups.slice(before), after },
  )

  // 代理塞一个监听，再请人登录：先重新载入
  await run('evaluate', {
    expression: `(window.__agentSpy = [], document.addEventListener('input', (e) => window.__agentSpy.push(e.target.value), true), 1)`,
  })
  const pending = call('request_sign_in', { site: 'Demo site', reason: 'To check your dashboard.' })
  check(
    '出了“代理请你登录”的卡片',
    await waitFor(() => signIns.list().length === 1),
    signIns.list(),
  )
  const [card] = signIns.list()
  check(
    '卡片上是代理说的站点和原因，归这个会话这个标签',
    card?.site === 'Demo site' &&
      card.reason === 'To check your dashboard.' &&
      card.threadId === 'thread-a' &&
      card.tabId === tab.id,
    card,
  )
  check(
    '交给人之前重新载入了：代理塞的监听没了',
    (await page('typeof window.__agentSpy')) === 'undefined',
  )

  // 冻结期间代理的工具一律被拒，CDP 也发不出去
  const refused: Record<string, string> = {}
  for (const [tool, args] of [
    ['snapshot', {}],
    ['screenshot', {}],
    ['evaluate', { expression: 'document.title' }],
    ['console', {}],
    ['click', { x: 10, y: 10 }],
    ['type', { text: 'x' }],
    ['navigate', { url: `${pageOrigin}/other` }],
  ] as const) {
    const reply = await call(tool, args)
    if (reply.success || !textOf(reply).includes(SIGNING_IN)) refused[tool] = textOf(reply)
  }
  check(
    '冻结期间快照、截图、执行脚本、点、输入、导航都被拒',
    Object.keys(refused).length === 0,
    refused,
  )
  const cdp = await tab.cdp('Runtime.evaluate', { expression: '1' }).then(
    () => 'sent',
    (error: unknown) => String(error),
  )
  check('冻结期间标签自己的 CDP 也发不出去', cdp.includes(SIGNING_IN), cdp)

  // 人点用户名框：原生菜单，选第二条填上；子框架里也填一个密码
  options.setPick(1)
  const [x, y] = (await page(
    `(() => { const r = document.querySelector('#user').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`,
  )) as [number, number]
  if (options.manual) {
    const bounds = window.getContentBounds()
    console.log(
      `LITCH_AUTOFILL_CLICK ${JSON.stringify({ label: 'agent-handover', x: Math.round(bounds.x + x), y: Math.round(bounds.y + y), pid: process.pid })}`,
    )
    const end = Date.now() + 90_000
    while (Date.now() < end && (await page('pass.value')) === '') await sleep(500)
  } else {
    window.focus()
    contents.focus()
    contents.sendInputEvent({ type: 'mouseMove', x, y })
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(800)
  }
  options.setPick(null)
  const filled = (await page('[user.value, pass.value]')) as string[]
  check(
    '交给人之后能用已保存的密码：弹菜单、选了填上',
    options.manual
      ? String(filled[0]).endsWith('@example.com') && filled[1] !== ''
      : popups.length > before &&
          filled[0] === popups.at(-1)?.[3] &&
          filled[1] === (filled[0] === 'bob@example.com' ? 'bob-pass-2' : 'ann-pass-1'),
    { popups: popups.slice(before), filled },
  )
  await contents.mainFrame.frames[0]?.executeJavaScript(`pass.value = 'typed-in-frame-7'`)

  // 人点“完成，交还”：密码框清空，代理拿到的只有“登录完了”
  signIns.answer(card?.id ?? '', 'done')
  const handed = textOf(await pending)
  const cleared = (await page('pass.value')) as string
  const frameCleared = await contents.mainFrame.frames[0]?.executeJavaScript('pass.value')
  check(
    '交还时各框架的密码框都清空了',
    cleared === '' && frameCleared === '' && String(filled[0]).endsWith('@example.com'),
    { cleared, frameCleared },
  )
  check(
    '代理拿到“用户登录完了”，不带输入',
    /finished signing in to Demo site/.test(handed) &&
      !/@example|pass-|typed-in-frame/.test(handed),
    handed,
  )
  check('交还之后代理照常能用', !(await run('snapshot')).includes(SIGNING_IN))

  // 再交一次，人点取消
  const again = call('request_sign_in', { reason: 'Need access.' })
  await waitFor(() => signIns.list().length === 1)
  signIns.answer(signIns.list()[0]?.id ?? '', 'cancel')
  check('人点取消：代理拿到“取消了”', /cancelled signing in/.test(textOf(await again)))

  // 代理自己输入新的一组再点登录：读页工具里都没有密码，导航完成后只给界面推一条保存提示
  const fresh = await run('snapshot')
  const boxes = [...fresh.matchAll(/textbox[^\n]*\[ref=(e\d+)\]/g)].map((match) => match[1])
  await run('type', { ref: boxes[0], text: 'carol@example.com', clear: true })
  const typed = await run('type', { ref: boxes[1], text: 'carol-pass-9', clear: true })
  check('type 不回报密码框的值', !typed.includes('carol-pass-9'), typed)
  const masked = await run('snapshot')
  check(
    '快照里遮住密码框',
    !masked.includes('carol-pass-9') && /textbox[^\n]*••••••/.test(masked),
    masked,
  )
  const evaluated = await run('evaluate', {
    expression: `({ a: document.querySelector('#pass').value, b: [...document.querySelectorAll('input')].map((one) => one.value) })`,
  })
  check('evaluate 的结果里替掉密码框的值', !evaluated.includes('carol-pass-9'), evaluated)
  const prompted = pushedPrompts.length
  await run('click', { ref: refOf(fresh, /button "Sign in"/) })
  await tab.waitForLoad(10_000, new AbortController().signal)
  await sleep(800)
  const latest = pushedPrompts.at(-1) as Array<Record<string, unknown>> | undefined
  check(
    '代理登录导航完成后给界面推了一条保存提示，里面没有密码',
    pushedPrompts.length > prompted &&
      !!latest?.some(
        (one) =>
          one.kind === 'save' &&
          one.username === 'carol@example.com' &&
          one.origin === pageOrigin &&
          one.tabId === tab.id,
      ) &&
      !JSON.stringify(pushedPrompts).includes('carol-pass-9'),
    pushedPrompts,
  )
  check('没人答之前没有存', options.storedCount() === 4, options.storedCount())
  check(
    '工具结果里从不出现密码、也不提保存提示',
    results.every(
      (text) =>
        !/bob-pass-2|ann-pass-1|carol-pass-9|typed-in-frame/.test(text) &&
        !/save (this )?password/i.test(text),
    ),
    results,
  )
}
