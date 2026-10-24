// Litch 代填真实窗口自检（probe-browser-fill.mts）的各条用例。网页在 probe-browser-fill-pages.mts。
import type { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import type { SignInRequest, SignIns } from './browser/passwords/signin.mjs'
import type { ClientToolAsk } from './client-tools/types.mjs'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface FillKit {
  open(path: string): Promise<HostTab | undefined>
  request(options?: {
    args?: Record<string, unknown>
    answer?: 'fill' | 'cancel' | ((card: SignInRequest) => void | Promise<void>)
    turn?: string
    remember?: boolean
  }): Promise<{ card: SignInRequest | null; text: string }>
  run(tool: string, args?: Record<string, unknown>, turnId?: string): Promise<string>
  refOf(snapshot: string, pattern: RegExp): string
  current(): HostTab | undefined
  waitFor<T>(get: () => T | undefined | null, ms?: number): Promise<T | null>
  postsTo(path: string): Array<{ path: string; body: string }>
  pushedPrompts: unknown[]
  shown: ClientToolAsk[]
  signIns: SignIns
  host: ReturnType<typeof createElectronHost>
  check(name: string, ok: boolean, detail?: unknown): void
  base: string
  password: string
  username: string
  /** 之后的调用算哪个定时任务的回合（null 是普通会话） */
  setTask(task: { id: string; name: string } | null): void
  /** 记下的事先授权（自检里的那份） */
  grants: Map<string, string>
  /** 核心转来一条手机答复 */
  phoneAnswer(answer: unknown): void
}

export async function runCases(kit: FillKit): Promise<void> {
  const { open, request, run, refOf, current, postsTo, pushedPrompts, check, host } = kit
  const sent = new URLSearchParams({ user: kit.username, pass: kit.password }).toString()
  const page = (tab: HostTab | undefined, code: string) =>
    tab ? tab.view.webContents.executeJavaScript(code) : Promise.resolve(undefined)
  const prompts = () => pushedPrompts.length

  // 1. 普通表单：卡片列这个源的账号，对话里同一张；代填后换文档，服务器收到对的账号，不出保存提示
  {
    const before = prompts()
    const plain = await open('/plain')
    // 直接在网页里做个记号（不经代理，不算执行过脚本）：后退回来还在就是往返缓存原样拿回的
    await page(plain, 'window.__litchProbeMark = 1')
    const { card, text } = await request({ answer: 'fill' })
    check(
      '卡片列出这个源的已存账号（完整用户名、打码的、随机 ref），能代填',
      card?.accounts.length === 1 &&
        card.accounts[0]?.username === kit.username &&
        card.accounts[0]?.masked === 'ag•••@example.com' &&
        card.fillBlocked === null &&
        card.origin === kit.base,
      card,
    )
    check(
      '对话里挂了同一张卡片',
      kit.shown.some((ask) => ask.kind === 'signIn' && ask.id === card?.id),
      kit.shown,
    )
    check(
      '代填后告诉代理换了文档',
      /Litch filled the account the user approved/.test(text) && !/did not load/.test(text),
      text,
    )
    check(
      '服务器收到人批准的那个账号',
      postsTo('/welcome').at(-1)?.body === sent,
      postsTo('/welcome'),
    )
    await sleep(300)
    check('Litch 代填的提交不出保存提示', prompts() === before, pushedPrompts.slice(before))
    const snapshot = await run('snapshot')
    check('解闸后代理照常能用、看到登进去的页面', /Signed in/.test(snapshot), snapshot)
    check('卡片收掉了', kit.signIns.list().length === 0, kit.signIns.list())
    // 后退拿不回填过密码的那一页（往返缓存）：代填后这个标签的历史清掉了
    const tab = current()
    const history = tab?.view.webContents.navigationHistory
    const couldGoBack = history?.canGoBack() ?? null
    const back = await run('navigate', { action: 'back' })
    const field = await page(current(), "document.getElementById('pass')?.value ?? null")
    const restored = await page(current(), 'window.__litchProbeMark ?? null')
    check(
      '代填后后退再读密码框：读不到密码（历史清了，后退不回登录页）',
      couldGoBack === false && field !== kit.password && !back.includes(kit.password),
      { couldGoBack, field, restored, back },
    )
  }

  // 2. 代理先执行过脚本（装了偷看输入的监听）：先重新载入，监听没了；单页应用不换文档，密码框清空
  {
    const tab = await open('/scripted')
    await run('evaluate', {
      expression: `(window.__spy = [], document.addEventListener('input', (e) => window.__spy.push(e.target.value), true), 1)`,
    })
    const { text } = await request({ answer: 'fill' })
    const spy = await run('evaluate', { expression: 'JSON.stringify(window.__spy ?? null)' })
    check(
      '执行过脚本的页面先重新载入：代理装的监听没收到密码',
      /null/.test(spy) && !spy.includes(kit.password),
      spy,
    )
    check(
      '单页应用不换文档：告诉代理没换文档、密码框清了',
      /did not load a new document, and Litch cleared/.test(text),
      text,
    )
    check('单页应用：密码框是空的', (await page(current() ?? tab, 'pass.value')) === '')
    check('单页应用：网页自己交上去的是对的账号', postsTo('/api/login').at(-1)?.body === sent)
  }

  // 3. “显示密码”的按钮当提交：点了它密码显示在页面上，自检发现，关掉重开
  {
    const tab = await open('/spa-show')
    const snapshot = await run('snapshot')
    const show = refOf(snapshot, /Show password/)
    const { text } = await request({ answer: 'fill', args: { submitRef: show } })
    const next = current()
    check(
      '“显示密码”按钮当提交：自检不干净，旧标签关掉、在新标签里重开',
      !!show &&
        /closed that tab and opened .* in a new tab/.test(text) &&
        next !== tab &&
        !host.page(tab?.id ?? ''),
      { text, show },
    )
    const after = await run('snapshot')
    check('重开的新标签里没有密码', !after.includes(kit.password) && /Sign in/.test(after), after)
  }

  // 4. GET 表单：不能代填（置灰写原因）；人拒绝后同一回合再请求直接回拒绝，不出卡片
  {
    await open('/get')
    let refused = false
    const { card, text } = await request({
      turn: 'turn-get',
      answer: (one) => {
        refused = !kit.signIns.answer(one.id, { fill: one.accounts[0]?.ref ?? '', remember: false })
        kit.signIns.answer(one.id, 'cancel')
      },
    })
    check(
      'GET 交密码的表单：卡片上 fillBlocked 是 insecure',
      card?.fillBlocked === 'insecure',
      card,
    )
    check('预检不过的卡片答不了代填', refused)
    check('拒绝：告诉代理别换办法', /declined signing in/.test(text), text)
    const again = await run('request_sign_in', { reason: 'Again.' }, 'turn-get')
    check(
      '同一回合同一个源再请求：直接回拒绝，不出卡片',
      /declined signing in/.test(again) && kit.signIns.list().length === 0,
      again,
    )
  }

  // 4b. 没写 method（HTML 默认 GET）、按钮 formmethod 是 get：卡片上不能代填；出卡片后才改成 GET 的，提交前挡下
  for (const path of ['/no-method', '/button-get']) {
    await open(path)
    const { card } = await request({ answer: 'cancel', turn: `turn${path}` })
    check(
      `${path}：实际用 GET 交，卡片上 fillBlocked 是 insecure`,
      card?.fillBlocked === 'insecure',
      card,
    )
  }
  {
    const posts = postsTo('/welcome').length
    await open('/method-flip')
    const { card, text } = await request({ answer: 'fill', turn: 'turn-flip' })
    const url = current()?.info().url ?? ''
    check(
      '提交前网页改成 GET 交：不提交，告诉代理 insecure，密码框清空、地址里没有密码',
      card?.fillBlocked === null &&
        /\(insecure\)/.test(text) &&
        postsTo('/welcome').length === posts &&
        !url.includes(encodeURIComponent(kit.password)) &&
        (await page(current(), 'pass.value')) === '',
      { text, url },
    )
  }

  // 5. 把密码打进控制台：闸开着时不收，代理读不到
  {
    await open('/spa-console')
    await request({ answer: 'fill' })
    const logs = await run('console')
    check('网页把密码打进控制台：代理读不到', !logs.includes('password is'), logs)
  }

  // 6. 把密码写进标题：自检发现，关掉重开；tabs 里看不到
  {
    const tab = await open('/spa-title')
    const { text } = await request({ answer: 'fill' })
    const tabs = await run('tabs', { action: 'list' })
    check(
      '网页把密码写进标题：关掉重开，tabs 里没有',
      /new tab/.test(text) && !host.page(tab?.id ?? '') && !tabs.includes(kit.password),
      { text, tabs },
    )
  }

  // 7. 弹框带着密码：代理的标签不弹系统对话框、闸开着时不记文字
  {
    await open('/spa-alert')
    const { text } = await request({ answer: 'fill' })
    const snapshot = await run('snapshot')
    check(
      '弹框带着密码：代理拿不到弹框文字',
      !/dialog is open/.test(text + snapshot) && /Welcome back/.test(snapshot),
      { text, snapshot },
    )
  }

  // 8. 靠弹窗登录（OAuth）：闸开着时不开弹窗，回 popup_needed
  {
    const before = host.pages().length
    await open('/spa-popup')
    const { text } = await request({ answer: 'fill' })
    check(
      'OAuth 弹窗：不开，告诉代理 popup_needed',
      /popup_needed/.test(text) &&
        host.pages().length === before + 1 &&
        !host.pages().some((one) => one.info().url.includes('/oauth')),
      { text, pages: host.pages().map((one) => one.info().url) },
    )
  }

  // 9. 编号指向搜索框：不在认出的登录表单里，卡片上 locator_invalid
  {
    await open('/search')
    const snapshot = await run('snapshot')
    const search = refOf(snapshot, /Search the site/)
    const one = await request({ answer: 'cancel', args: { usernameRef: search }, turn: 'turn-s1' })
    check(
      '用户名的编号指向搜索框：locator_invalid',
      !!search && one.card?.fillBlocked === 'locator_invalid',
      { search, card: one.card },
    )
    await run('snapshot')
    const two = await request({ answer: 'cancel', args: { passwordRef: search }, turn: 'turn-s2' })
    check(
      '密码的编号指向搜索框：locator_invalid',
      two.card?.fillBlocked === 'locator_invalid',
      two.card,
    )
  }

  // 10. 两步登录：先填用户名提交，换页后填密码提交，一次做完
  {
    await open('/step1')
    const { text } = await request({ answer: 'fill' })
    const user = new URLSearchParams({ user: kit.username }).toString()
    const pass = new URLSearchParams({ pass: kit.password }).toString()
    check(
      '两步登录：用户名交给第一步、密码交给第二步',
      postsTo('/step2').at(-1)?.body === user && postsTo('/welcome').at(-1)?.body === pass,
      { text, step2: postsTo('/step2'), welcome: postsTo('/welcome').slice(-1) },
    )
    check('两步登录：告诉代理登上了', /Litch filled/.test(text) && !/could not/.test(text), text)
  }

  // 11. 交了密码要验证码：告诉代理要再请求，再请求时卡片只给“我自己登录”
  {
    await open('/otp-login')
    const { text } = await request({ answer: 'fill' })
    check('验证码页：告诉代理还要验证', /extra verification/.test(text), text)
    // 我自己登录 → 交还（方案 A 照旧）
    let self = false
    let manual = false
    const again = await request({
      turn: 'turn-otp',
      answer: (card) => {
        self = kit.signIns.answer(card.id, 'self')
        manual = kit.signIns.get(card.id)?.stage === 'manual'
        kit.signIns.answer(card.id, 'done')
      },
    })
    check(
      '再请求：卡片上 fillBlocked 是 verification',
      again.card?.fillBlocked === 'verification',
      again.card,
    )
    await sleep(300)
    check(
      '我自己登录：卡片转成交还，答完收掉',
      self && manual && /finished signing in/.test(again.text) && kit.signIns.list().length === 0,
      again.text,
    )
  }

  // 12. 定时任务的回合：卡片有过期时间和勾选；勾了之后同一个任务不出卡片直接代填；普通会话照常出卡片
  {
    kit.setTask({ id: 'task-1', name: '日报' })
    await open('/plain')
    const first = await request({ answer: 'fill', remember: true, turn: 'turn-task-1' })
    check(
      '定时任务的回合：卡片带任务、30 分钟后过期',
      first.card?.taskId === 'task-1' &&
        first.card.expiresAt !== null &&
        Math.abs(first.card.expiresAt - first.card.at - 30 * 60_000) < 1000,
      first.card,
    )
    check('勾了“以后直接用这个账号”：代填成功后记下授权', kit.grants.size === 1, [...kit.grants])
    await open('/plain')
    const before = kit.shown.length
    const second = await run('request_sign_in', { reason: 'Probe.' }, 'turn-task-2')
    check(
      '事先授权过：不出卡片，直接代填，告诉代理是事先授权的',
      /authorized in advance for this task/.test(second) && kit.shown.length === before,
      second,
    )
    kit.setTask(null)
    await open('/plain')
    const plain = await request({ answer: 'cancel', turn: 'turn-plain' })
    check(
      '普通会话没有事先授权：照常出卡片，没有过期时间',
      plain.card?.expiresAt === null,
      plain.card,
    )
  }

  // 13. 手机的答复：验签不过的丢掉、卡片接着等；过了的照它代填
  {
    await open('/plain')
    let stillWaiting = false
    const { text } = await request({
      turn: 'turn-phone',
      answer: async (card) => {
        const ref = card.accounts[0]?.ref ?? null
        kit.phoneAnswer({ id: card.id, nonce: card.nonce, ref, signature: 'forged' })
        await sleep(300)
        stillWaiting = kit.signIns.get(card.id)?.stage === 'choose'
        kit.phoneAnswer({ id: card.id, nonce: card.nonce, ref, signature: 'good' })
      },
    })
    check('手机答复验签不过：丢掉，卡片接着等', stillWaiting)
    check(
      '手机答复验签过了：照它代填',
      /Litch filled the account the user approved/.test(text),
      text,
    )
  }
}
