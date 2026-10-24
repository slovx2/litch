// 浏览器面板上“代理请你登录”的卡片（probe-browser-ui.mts 的一段）：眼前会话里代理开一个标签、调 request_sign_in，
// 面板上出卡片（站点、原因；库里没有这个网站的账号，只有“我自己登录”“拒绝”），点“我自己登录”换成“完成，交还”“取消”，
// 点“完成，交还”之后调用回“登录完了”、卡片没了；再调一次点“拒绝”，回“取消了”；再调一次打断回合，卡片变成“代理已收回”，点“知道了”才没。
// 再让一个执行过脚本的标签交出去之前重新打开不成（自带的小服务第二次 GET 回 204）：卡片是“标签已关掉”，
// 没有“显示”“完成”，点“知道了”才没。
// 最后关掉代理的标签，不影响后面几段。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
      // 每次请人登录算一个新回合：同一回合里人拒绝过的源，再请求直接回拒绝（这里要的是每次都出卡片）
      turnId: tool === 'request_sign_in' ? `turn-signin-${seq}` : 'turn-signin',
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
  check(
    '登录卡片：库里没有这个网站的账号时先让人选，写明没有已存账号，只有“我自己登录”“拒绝”，没有“用账号登录”',
    (await page(
      "(() => { const card = document.querySelector('.bw-signin'); return card?.dataset.stage === 'choose' && !!card.querySelector('[data-sign-in-none]') && !!card.querySelector('[data-act=\"sign-in-self\"]') && !card.querySelector('[data-act=\"sign-in-fill\"], [data-act=\"sign-in-done\"]') })()",
    )) === true,
    await page("document.querySelector('.bw-signin')?.outerHTML ?? null"),
  )
  await shot('sign-in-card')
  await page(`document.querySelector('.bw-signin [data-act="sign-in-self"]').click()`)
  check(
    '登录卡片：点“我自己登录”之后换成“完成，交还”“取消”那一版',
    await until(
      `document.querySelector('.bw-signin')?.dataset.stage === 'manual' && !!document.querySelector('.bw-signin [data-act="sign-in-done"]')`,
      10_000,
    ),
    await page("document.querySelector('.bw-signin')?.outerHTML ?? null"),
  )
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
  check('登录卡片：点“拒绝”之后调用回拒绝了', /declined signing in/.test(cancelled), cancelled)

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

  // 重新打开不成：标签关掉，卡片是“标签已关掉”，不指向标签
  let served = false
  const server = createServer((request, response) => {
    request.resume()
    if (served) {
      response.writeHead(204)
      response.end()
      return
    }
    served = true
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Once</title><input type="password">')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await call('navigate', { url: `http://127.0.0.1:${port}/once`, newTab: true })
  await call('evaluate', { expression: '1' })
  const failed = textOf(await call('request_sign_in', { reason: 'Need access.' }))
  server.close()
  check(
    '登录卡片：重新打开不成时标签关掉，卡片是“标签已关掉”，没有“显示”“完成”',
    /could not be reloaded safely/.test(failed) &&
      (await until(
        `document.querySelector('.bw-signin')?.dataset.state === 'closed' && !document.querySelector('.bw-signin [data-act="sign-in-show"]') && !document.querySelector('.bw-signin [data-act="sign-in-done"]')`,
        10_000,
      )),
    { failed, card: await page("document.querySelector('.bw-signin')?.outerHTML ?? null") },
  )
  await shot('sign-in-closed')
  await page(`document.querySelector('.bw-signin [data-act="sign-in-dismiss"]').click()`)
  check(
    '登录卡片：“标签已关掉”点“知道了”就没了',
    await until("!document.querySelector('.bw-signin')"),
  )

  for (const tab of browser.host.list()) {
    if (tab.kind === 'agent') browser.host.close(tab.id)
  }
}
