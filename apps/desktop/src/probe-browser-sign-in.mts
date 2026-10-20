// 浏览器面板上“代理请你登录”的卡片（probe-browser-ui.mts 的一段）：眼前会话里代理开一个标签、调 request_sign_in，
// 面板上出卡片（站点、原因、“完成，交还”“取消”），点“完成，交还”之后调用回“登录完了”、卡片没了；
// 再调一次点“取消”，回“取消了”；再调一次打断回合，卡片变成“代理已收回”，点“知道了”才没。
// 最后关掉代理的标签，不影响后面几段。
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import type { InstalledBrowser } from './browser/install.mjs'
import type { TabOwner } from './browser/model.mjs'
import type { ClientToolInvocation } from './client-tools/types.mjs'

export async function checkSignInCard(options: {
  browser: InstalledBrowser
  owner: TabOwner
  url: string
  page(code: string): Promise<unknown>
  until(code: string, ms?: number): Promise<boolean>
  check(name: string, ok: boolean, detail?: unknown): void
  shot(name: string): Promise<void>
}): Promise<void> {
  const { browser, owner, url, page, until, check, shot } = options
  let seq = 0
  const call = (
    tool: string,
    args: Record<string, unknown>,
    signal = new AbortController().signal,
  ) => {
    const invocation: ClientToolInvocation = {
      id: `signin-${++seq}`,
      threadId: owner.threadId,
      turnId: 'turn-signin',
      callId: `s${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: { id: owner.deviceId, name: '本机', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
    }
    return browser.executor.call(invocation, {
      signal,
      ask: async () => 'once',
    })
  }
  const textOf = (reply: ClientToolCallResponse) =>
    reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')

  await call('navigate', { url, newTab: true })
  const pending = call('request_sign_in', { site: 'Demo site', reason: 'To check your dashboard.' })
  check(
    '登录卡片：面板上出“代理请你登录”，有站点和原因',
    await until(
      "document.querySelector('.bw-signin')?.textContent.includes('Demo site') && document.querySelector('.bw-signin').textContent.includes('To check your dashboard.')",
      10_000,
    ),
    await page("document.querySelector('.bw-signin')?.outerHTML ?? null"),
  )
  check(
    '登录卡片：醒目的是外壳取到的真实来源',
    (await page("document.querySelector('.bw-signin [data-sign-in-origin]')?.textContent")) ===
      new URL(url).origin,
  )
  await shot('sign-in-card')
  await page(`document.querySelector('.bw-signin [data-act="sign-in-done"]').click()`)
  const done = textOf(await pending)
  check(
    '登录卡片：点“完成，交还”之后调用回登录完了、卡片没了',
    /finished signing in to Demo site/.test(done) &&
      (await until("!document.querySelector('.bw-signin')")),
    done,
  )

  const again = call('request_sign_in', { reason: 'Need access.' })
  await until("!!document.querySelector('.bw-signin')", 10_000)
  await page(`document.querySelector('.bw-signin [data-act="sign-in-cancel"]').click()`)
  const cancelled = textOf(await again)
  check('登录卡片：点“取消”之后调用回取消了', /cancelled signing in/.test(cancelled), cancelled)

  // 回合打断：卡片变成“代理已收回”，只有“知道了”，点了才没
  const controller = new AbortController()
  const withdrawn = call('request_sign_in', { reason: 'Need access.' }, controller.signal)
  await until("document.querySelector('.bw-signin')?.dataset.state === 'waiting'", 10_000)
  controller.abort()
  await withdrawn
  check(
    '登录卡片：回合打断后变成“代理已收回”，提醒别再输入',
    await until(
      `document.querySelector('.bw-signin')?.dataset.state === 'withdrawn' && !document.querySelector('.bw-signin [data-act="sign-in-done"]')`,
      10_000,
    ),
    await page("document.querySelector('.bw-signin')?.outerHTML ?? null"),
  )
  await shot('sign-in-withdrawn')
  await page(`document.querySelector('.bw-signin [data-act="sign-in-dismiss"]').click()`)
  check('登录卡片：点“知道了”就没了', await until("!document.querySelector('.bw-signin')"))

  for (const tab of browser.host.list()) {
    if (tab.kind === 'agent') browser.host.close(tab.id)
  }
}
