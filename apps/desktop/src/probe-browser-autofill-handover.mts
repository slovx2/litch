// 交给人登录出岔子的几种（probe-browser-autofill.mts 的一段，跟在 probe-browser-autofill-agent.mts 后面）：
// 1. 执行过脚本、交出去之前没能重新打开（测试页第二次 GET 回 204，不换文档）：不交给人，关掉标签，卡片变成“标签已关掉”；
// 2. 回合打断时先清一遍框，再重新打开；重新打开不成同上，不解冻；
// 3. 交接期间网页开的弹窗、弹窗里再开的弹窗都开成用户的标签、代理看不到；交出去的标签被关掉时一并关掉；
// 4. 回合打断之后回合结束、代理的标签被关掉：“代理已收回”的卡片随标签撤掉，不留指向不存在的标签的卡片；
// 5. 交接期间后退、前进不可用（面板按钮灰、宿主不执行），同一个标签再请一次只回“已在等”、不动这一次交接。
import { ipcMain } from 'electron'
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import type { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import type { BrowserExecutor } from './browser/executor.mjs'
import { AUTOFILL_CLEARED } from './browser/passwords/ipc.mjs'
import type { SignIns } from './browser/passwords/signin.mjs'
import type { ClientToolInvocation } from './client-tools/types.mjs'

/** 第一次 GET 给这一页，之后回 204（不换文档），用来造“重新打开不成” */
export const ONCE =
  '<!doctype html><title>Once</title><form><input id="pass" type="password" style="width:200px"></form>'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function checkHandoverFailures(options: {
  host: ReturnType<typeof createElectronHost>
  executor: BrowserExecutor
  signIns: SignIns
  pageOrigin: string
  check(name: string, ok: boolean, detail?: unknown): void
}): Promise<void> {
  const { host, executor, signIns, pageOrigin, check } = options
  let seq = 0
  const textOf = (reply: ClientToolCallResponse) =>
    reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')
  const call = (
    tool: string,
    args: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) => {
    const invocation: ClientToolInvocation = {
      id: `fail-${++seq}`,
      threadId: 'thread-a',
      turnId: 'turn-1',
      callId: `f${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: { id: 'local', name: '本机', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
    }
    return executor.call(invocation, { signal, ask: async () => null })
  }
  const waitFor = async (test: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end && !test()) await sleep(100)
    return test()
  }
  const contentsOf = (id: string) => (host.page(id) as HostTab | undefined)?.view.webContents
  /** 开一个新的代理标签，回它的编号 */
  const openTab = async (path: string) => {
    const before = new Set(host.pages().map((one) => one.id))
    await call('navigate', { url: `${pageOrigin}${path}`, newTab: true })
    return host.pages().find((one) => !before.has(one.id))?.id ?? ''
  }
  const exists = (id: string) => host.pages().some((one) => one.id === id)
  const dismissAll = () => {
    for (const one of signIns.list()) signIns.answer(one.id, 'dismiss')
  }
  dismissAll()

  // 1. 执行过脚本，交出去之前没能重新打开：不交给人，关掉标签
  const scriptedTab = await openTab('/once-a')
  await call('evaluate', { expression: '1' })
  const failed = textOf(await call('request_sign_in', { reason: 'Need access.' }))
  const [closedCard] = signIns.list()
  check(
    '执行过脚本、交出去之前没能重新打开：不交给人，标签关掉，卡片是“标签已关掉”，代理拿到失败',
    /could not be reloaded safely/.test(failed) &&
      !exists(scriptedTab) &&
      signIns.list().length === 1 &&
      closedCard?.state === 'closed' &&
      closedCard.tabId === scriptedTab,
    { failed, list: signIns.list() },
  )
  dismissAll()

  // 2. 回合打断：先清一遍框（各框架回了清框），再重新打开；重新打开不成就关掉标签、不解冻
  const abortTab = await openTab('/once-b')
  const abortContents = contentsOf(abortTab)
  let acks = 0
  const onAck = (event: Electron.IpcMainEvent) => {
    if (event.sender === abortContents) acks++
  }
  ipcMain.on(AUTOFILL_CLEARED, onAck)
  const controller = new AbortController()
  const withdrawn = call('request_sign_in', { reason: 'Need access.' }, controller.signal)
  await waitFor(() => signIns.list()[0]?.state === 'waiting')
  await abortContents?.executeJavaScript(`pass.value = 'half-typed-5'; 1`)
  controller.abort()
  await withdrawn
  const closedAfterAbort = await waitFor(
    () => !exists(abortTab) && signIns.list()[0]?.state === 'closed',
    20_000,
  )
  ipcMain.removeListener(AUTOFILL_CLEARED, onAck)
  check(
    '回合打断：先清了一遍框，重新打开不成就关掉标签，卡片是“标签已关掉”',
    closedAfterAbort && acks > 0,
    { acks, list: signIns.list() },
  )
  dismissAll()

  // 3. 弹窗里再开的弹窗也算这次交接：代理看不到，交出去的标签被关掉时一并关掉
  const openerTab = await openTab('/login')
  const opener = contentsOf(openerTab)
  const pending = call('request_sign_in', { reason: 'Need access.' })
  await waitFor(() => signIns.list()[0]?.state === 'waiting')
  const popupOf = async (from: Electron.WebContents | undefined, path: string) => {
    const before = new Set(host.pages().map((one) => one.id))
    await from?.executeJavaScript(`window.open(${JSON.stringify(path)}); 1`, true)
    await waitFor(() => host.pages().some((one) => !before.has(one.id)))
    return host.pages().find((one) => !before.has(one.id))?.id ?? ''
  }
  const first = await popupOf(opener, '/popup-a')
  const second = await popupOf(contentsOf(first), '/popup-b')
  const listed = textOf(await call('tabs', { action: 'list' }))
  const hidden = (JSON.parse(listed) as { tabs: Array<Record<string, unknown>> }).tabs.filter(
    (one) => one.tabId === first || one.tabId === second,
  )
  check(
    '弹窗里再开的弹窗也开成用户的标签，tabs list 里只给占位',
    !!first &&
      !!second &&
      host.page(second)?.info().kind === 'user' &&
      hidden.length === 2 &&
      hidden.every((one) => one.signingIn === true) &&
      !listed.includes('popup-b'),
    { listed },
  )
  host.close(openerTab)
  const closedOutcome = textOf(await pending)
  check(
    '交出去的标签被关掉：弹窗和弹窗里再开的一并关掉，卡片撤掉',
    /tab was closed/.test(closedOutcome) &&
      (await waitFor(() => !exists(first) && !exists(second))) &&
      signIns.list().length === 0,
    { closedOutcome, pages: host.pages().map((one) => one.id), list: signIns.list() },
  )

  // 5. 后退、前进不可用；同一个标签再请一次被拒（已冻结时执行器先拒；前后脚进来的回“已在等”，见单测）
  const backTab = await openTab('/login')
  await call('navigate', { url: `${pageOrigin}/login?second` })
  const backPage = host.page(backTab)
  const asking = call('request_sign_in', { reason: 'Need access.' })
  await waitFor(() => signIns.list()[0]?.state === 'waiting')
  const frozenInfo = backPage?.info()
  host.userNavigate(backTab, 'back')
  await sleep(800)
  const again = textOf(await call('request_sign_in', { reason: 'Again.' }))
  check(
    '交接期间后退、前进不可用，宿主也不执行；再请一次只回“已在等”，卡片还是原来那张',
    frozenInfo?.canGoBack === false &&
      !!backPage?.info().url.endsWith('/login?second') &&
      /already waiting for the user|is signing in on this tab/.test(again) &&
      signIns.list().length === 1 &&
      signIns.list()[0]?.reason === 'Need access.',
    { frozenInfo, url: backPage?.info().url, again, list: signIns.list() },
  )
  signIns.answer(signIns.list()[0]?.id ?? '', 'cancel')
  await asking
  check('交接结束后退又能用了', backPage?.info().canGoBack === true)

  // 4. 回合打断之后回合结束关掉代理的标签：“代理已收回”的卡片随标签撤掉
  await openTab('/login')
  const late = new AbortController()
  const lateCall = call('request_sign_in', { reason: 'Need access.' }, late.signal)
  await waitFor(() => signIns.list()[0]?.state === 'waiting')
  late.abort()
  await lateCall
  const wasWithdrawn = await waitFor(() => signIns.list()[0]?.state === 'withdrawn', 20_000)
  executor.turnEnded({ deviceId: 'local', threadId: 'thread-a', turnId: 'turn-1' })
  check(
    '回合结束关掉代理的标签：“代理已收回”的卡片随标签撤掉',
    wasWithdrawn && (await waitFor(() => signIns.list().length === 0)),
    signIns.list(),
  )
}
