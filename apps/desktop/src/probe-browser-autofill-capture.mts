// 自动填充真实窗口自检（probe-browser-autofill.mts）里认登录提交的那一段，只在自动的那一遍跑：
// 另开一个用户标签，真的点按钮（受信任的输入事件）提交几种登录表单，看推给界面的保存提示对不对：
// - 两步登录的第二页：用户名框藏着，用藏着的那个用户名，不存空的；
// - 改密码表单（当前、新、确认，没有用户名框）：以新密码为准，拿当前密码认出是哪一条，提示更新；
// - 只在子框架里完成的登录（子框架自己导航，主框架不动）也出提示；
// - 网页自己 dispatchEvent 的 submit、脚本 requestSubmit 的都不算。
// 最后关掉这个标签，提示跟着没了。都不答，库里不多东西。
import type { BrowserWindow } from 'electron'
import type { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'

type Prompt = { kind?: string; username?: string; origin?: string; tabId?: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const STEP2 = `<!doctype html><title>Password</title>
<form method="post" action="/welcome" style="margin:20px">
<input type="email" autocomplete="username" value="two@example.com" style="display:none">
<input id="pass" type="password" style="display:block;width:240px;height:28px">
<button id="go">Next</button></form>`

export const CHANGE = `<!doctype html><title>Change password</title>
<form method="post" action="/welcome" style="margin:20px">
<input id="cur" type="password" autocomplete="current-password" style="display:block;width:240px;height:28px">
<input id="new" type="password" autocomplete="new-password" style="display:block;width:240px;height:28px">
<input id="again" type="password" autocomplete="new-password" style="display:block;width:240px;height:28px">
<button id="go">Change</button></form>`

/** 网页自己造的提交：dispatchEvent 一个 submit、requestSubmit（拦下不导航），然后脚本自己刷新 */
export const FORGED = `<!doctype html><title>Forged</title>
<form id="f" method="post" action="/welcome"><input id="user" type="email" value="forged@example.com">
<input id="pass" type="password" value="forged-pass-1"><button>Sign in</button></form>
<script>
const f = document.getElementById('f')
let once = true
f.addEventListener('submit', (event) => { if (once) event.preventDefault() })
setTimeout(() => {
  f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  f.requestSubmit()
  once = false
  setTimeout(() => location.replace('/after-forged'), 200)
}, 300)
</script>`

export async function checkCaptures(options: {
  window: BrowserWindow
  host: ReturnType<typeof createElectronHost>
  owner: { deviceId: string; threadId: string }
  pageOrigin: string
  frameOrigin: string
  pushedPrompts: unknown[]
  check(name: string, ok: boolean, detail?: unknown): void
}): Promise<void> {
  const { window, host, owner, pageOrigin, frameOrigin, pushedPrompts, check } = options
  const opened = host.openForUser(owner, `${pageOrigin}/forged`)
  const tab = host.page(opened.id) as HostTab
  const [width, height] = window.getContentSize()
  host.place(window, opened.id, { x: 0, y: 0, width: width ?? 900, height: height ?? 640 })
  const contents = tab.view.webContents
  const latest = () => (pushedPrompts.at(-1) as Prompt[] | undefined) ?? []
  const mine = () => latest().filter((one) => one.tabId === opened.id)
  const waitPrompt = async (test: (one: Prompt) => boolean, ms = 8000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const hit = mine().find(test)
      if (hit) return hit
      await sleep(200)
    }
    return null
  }
  const clickIn = async (
    run: (code: string) => Promise<unknown>,
    offset: [number, number],
    selector: string,
  ) => {
    const [x, y] = (await run(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`,
    )) as [number, number]
    const at = { x: offset[0] + x, y: offset[1] + y }
    contents.sendInputEvent({ type: 'mouseMove', ...at })
    contents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  }
  const main = (code: string) => contents.executeJavaScript(code)

  // 网页自己造的提交，接着自己导航：不出提示
  await tab.waitForLoad(10_000, new AbortController().signal)
  await sleep(1500)
  await tab.waitForLoad(10_000, new AbortController().signal)
  check(
    '网页 dispatchEvent、requestSubmit 的提交不出保存提示',
    !mine().some((one) => one.username === 'forged@example.com') &&
      contents.getURL().endsWith('/after-forged'),
    { prompts: mine(), url: contents.getURL() },
  )

  // 两步登录的第二页
  await tab.load(`${pageOrigin}/step2`, 10_000)
  await main(`pass.value = 'two-pass-4'`)
  await clickIn(main, [0, 0], '#go')
  const step = await waitPrompt((one) => one.username === 'two@example.com')
  check(
    '两步登录的第二页：用藏着的用户名提示保存，不存空的',
    step?.kind === 'save' && !mine().some((one) => one.username === ''),
    mine(),
  )

  // 改密码：没有用户名框，当前密码是 ann 的
  await tab.load(`${pageOrigin}/change`, 10_000)
  await main(
    `cur.value = 'ann-pass-1'; document.getElementById('new').value = 'ann-pass-NEW'; again.value = 'ann-pass-NEW'`,
  )
  await clickIn(main, [0, 0], '#go')
  const change = await waitPrompt((one) => one.username === 'ann@example.com')
  check('改密码表单：以新密码为准，认出是 ann，提示更新', change?.kind === 'update', mine())

  // 只在子框架里登录：子框架提交、自己导航，主框架不动
  await tab.load(`${pageOrigin}/login`, 10_000)
  await sleep(500)
  const frame = contents.mainFrame.frames[0]
  const box = (await main(
    `(() => { const r = document.querySelector('#sub').getBoundingClientRect(); return [r.left + 1, r.top + 1] })()`,
  )) as [number, number]
  await frame?.executeJavaScript(`user.value = 'sub-user'; pass.value = 'sub-pass-5'`)
  const before = contents.getURL()
  if (frame) await clickIn((code) => frame.executeJavaScript(code), box, '#go')
  const inFrame = await waitPrompt((one) => one.username === 'sub-user')
  check(
    '只在子框架里完成的登录也出提示（按子框架的源）',
    inFrame?.origin === frameOrigin && contents.getURL() === before,
    { prompts: mine(), url: contents.getURL() },
  )

  // 关掉标签，这个标签的提示跟着没了
  host.close(opened.id)
  await sleep(500)
  check('标签关掉之后它的保存提示跟着没了', mine().length === 0, latest())
}
