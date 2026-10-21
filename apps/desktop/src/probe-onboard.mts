// 上手功能的验收，对着模拟核心的 fresh 开局（本机一个 harness 都没装，LITCH_MOCK_SCENE=fresh）：
// 首启引导第一步列出全部支持的 harness；装 Codex 固定失败，回退里有原因、可展开的日志、官方命令、说明链接、
// 重新检测；装 Claude Code 日志一行行出来，装好进第二步；点“打开配置助手”到新建页，输入框里是那一句加手册的技能片；
// 引导记成走完。然后在对话里跑两次 litch config（模拟核心认“配置：…”）：打开 Computer Use 要在确认卡上点允许，
// 换皮肤由界面照做。然后从设置页“配置助手”一组重新打开引导再关掉。
// 最后看配置助手的预填只做一次：发过之后再进新建页，输入框是空的、没有技能片；点了没发、去设置页再回来，不再放一遍。
// 和别的验收一样，onboardProbe 会被原样送进页面里执行，不能引用函数外面的东西；judgeOnboard 在主进程里跑。

export interface OnboardProbe {
  /** 第一步：出没出、列了哪些 harness、Claude 的按钮上写的什么 */
  step1: boolean
  listed: string[]
  claudeButton: string
  /** Codex 没装成：原因、日志展开后的内容、官方命令、说明链接、重新检测 */
  failure: string
  failedLog: string
  manual: string
  docs: string
  recheck: boolean
  /** Claude 装的时候看到的日志末尾 */
  runningTail: string
  /** 装好后到了第二步 */
  step2: boolean
  /** 点了打开配置助手：引导收了、输入框里的字、技能片、记成走完 */
  closed: boolean
  draft: string
  chip: string
  stored: string | null
  /** litch config：确认卡上写的、允许后的回答、换皮肤 */
  card: string
  cardItems: string
  reply: string
  /** 过程区里那条命令（收在“运行 1 条命令”那一行里，点开了才看得到） */
  command: string
  /** 撤不回的那张卡（清内置浏览器数据）：标题、项、拒绝之后的回答 */
  eraseTitle: string
  eraseItems: string
  eraseReply: string
  skin: string
  /** 设置页重新打开引导、再关掉 */
  reopened: string
  reclosed: boolean
  /** 配置助手放好、发出去之后再进新建页：输入框里的字、技能片几个 */
  afterSendDraft: string
  afterSendChips: number
  /** 点了配置助手没发，去设置页再回来：输入框里的字、技能片几个 */
  revisitDraft: string
  revisitChips: number
}

export async function onboardProbe(): Promise<OnboardProbe> {
  // 后面两句配置话是一句接一句发的，量的是各自那一回合的确认卡：前一回合可能还没收完，按排队发
  //（设置里默认是立即发送，会插进前一回合，见 probe-compose-send.mts）
  const sendMode = (window as unknown as { __litchSendMode?: { set(mode: string): void } })
    .__litchSendMode
  if (!sendMode) throw new Error('界面上没有给验收换发送方式的口子（window.__litchSendMode）')
  sendMode.set('queue')
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ): Promise<T> => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    const last = check()
    if (last) return last
    throw new Error(`上手功能的验收：等不到${what}（页面上是 ${text(one('.main')).slice(0, 300)}）`)
  }
  /** 往受控的输入框里填字：经原生的写值口子写，再发一个 input，React 才认 */
  const fill = (area: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }
  /** 在输入框里写一句发出去 */
  const send = async (line: string) => {
    const area = await until('输入框', () => one<HTMLTextAreaElement>('.cmp-text'))
    fill(area, line)
    await sleep(50)
    const button = await until('发送按钮能点', () => {
      const found = one<HTMLButtonElement>('button.send:not(.stop)')
      return found && !found.disabled ? found : null
    })
    button.click()
  }

  // ---------- 第一步 ----------
  const step1 = await until('首启引导的第一步', () => one('.onb[data-onboarding="install"]'))
  await until('版本情况到了（Claude 有安装按钮）', () =>
    one('[data-onboard-harness="claude"] [data-act="install"]'),
  )
  const listed = all('[data-onboard-harness]').map(
    (element) => element.dataset.onboardHarness ?? '',
  )
  const claudeButton = text(one('[data-onboard-harness="claude"] [data-act="install"]'))

  // Codex 固定装不上
  one<HTMLButtonElement>('[data-onboard-harness="codex"] [data-act="install"]')?.click()
  const fallback = await until('Codex 没装成的回退', () =>
    one('[data-onboard-harness="codex"] [data-install-fallback]'),
  )
  const failure = text(one('[data-install-failure]', fallback))
  one<HTMLButtonElement>('[data-act="install-log"]', fallback)?.click()
  const failedLog = text(
    await until('展开的日志', () => one('[data-install-log="full"]', fallback)),
  )
  const manual = text(one('.inst-cmd code', fallback))
  const docs = one<HTMLAnchorElement>('.inst-docs', fallback)?.href ?? ''
  const recheck = one('[data-act="install-recheck"]', fallback) !== null

  // Claude 装得上：进行中看得到日志末尾，装好进第二步
  await until('Claude 的安装按钮能点', () => {
    const button = one<HTMLButtonElement>('[data-onboard-harness="claude"] [data-act="install"]')
    return button && !button.disabled ? button : null
  }).then((button) => button.click())
  const runningTail = text(
    await until('安装中的日志末尾', () => {
      const tail = one('[data-onboard-harness="claude"] [data-install-log="tail"]')
      return tail && text(tail).includes('Downloading') ? tail : null
    }),
  )
  const step2 =
    (await until('第二步', () => one('.onb[data-onboarding="assist"]'), 20_000)) !== null

  // ---------- 打开配置助手 ----------
  one<HTMLButtonElement>('[data-act="onboard-assistant"]')?.click()
  const closed = await until('引导收起', () => one('.onb') === null)
  const chipElement = await until('输入框里的技能片', () => one('.cmp-chip[data-kind="skill"]'))
  const draft = one<HTMLTextAreaElement>('.cmp-text')?.value ?? ''
  const chip = text(chipElement)
  let stored: string | null = null
  try {
    stored = localStorage.getItem('litch.onboarding')
  } catch {
    stored = null
  }

  // ---------- litch config：放宽安全的要点允许 ----------
  await send('配置：tools set local --computer on')
  const dialog = await until('确认卡', () => one('[data-config-confirm]'))
  const card = text(dialog)
  const cardItems = all('[data-item]', dialog)
    .map((element) => element.dataset.item ?? '')
    .join(',')
  one<HTMLButtonElement>('[data-act="config-allow"]', dialog)?.click()
  const reply = await until('允许之后的回答', () => {
    const main = text(one('.main'))
    return main.includes('照你说的改好了') ? main : null
  })
  for (const head of all('.steps-head[aria-expanded="false"]')) head.click()
  const command = await until('点开过程区里的那条命令', () =>
    all('.steps .item')
      .map((item) => text(item))
      .find((line) => line.includes('litch config')),
  ).catch(() => '')
  // 撤不回的也出卡（E7）：点拒绝，什么都不删
  await send('配置：browser clear-data')
  const erase = await until('删除的确认卡', () => {
    const element = one('[data-config-confirm]')
    return element &&
      element.getAttribute('data-config-confirm') !== dialog.getAttribute('data-config-confirm')
      ? element
      : null
  })
  const eraseTitle = text(one('.confirm-body > b', erase))
  const eraseItems = all('[data-item]', erase)
    .map((element) => element.dataset.item ?? '')
    .join(',')
  one<HTMLButtonElement>('[data-act="config-decline"]', erase)?.click()
  const eraseReply = await until('拒绝之后的回答', () => {
    const main = text(one('.main'))
    return main.includes('browser clear-data') && main.includes('没做成') ? main : null
  })
  // 界面那几项：换皮肤由这个窗口照做
  await send('配置：look set --skin human')
  const skin = await until('皮肤换成文艺', () =>
    document.documentElement.dataset.skin === 'human' ? 'human' : null,
  )

  // ---------- 设置页重新打开引导 ----------
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页的配置助手一组', () =>
      one<HTMLButtonElement>('.set-nav [data-section="assist"]'),
    )
  ).click()
  ;(
    await until('重新打开引导的按钮', () =>
      one<HTMLButtonElement>('[data-act="reopen-onboarding"]'),
    )
  ).click()
  const reopened =
    (await until('重新打开的引导', () => one('.onb')))?.getAttribute('data-onboarding') ?? ''
  one<HTMLButtonElement>('[data-act="onboard-close"]')?.click()
  const reclosed = await until('再关掉', () => one('.onb') === null)

  // ---------- 预填只做一次 ----------
  const skillChips = () => all('.cmp-chip[data-kind="skill"]').length
  /** 从侧栏最上面进新建页，等输入框出来，再多等一会儿：要是还会预填，这段时间里就填上了 */
  const toNewPage = async () => {
    one<HTMLButtonElement>('.sb-link.new')?.click()
    const area = await until('新建页的输入框', () =>
      one('.new-hero') ? one<HTMLTextAreaElement>('.cmp-text') : null,
    )
    await sleep(1500)
    return area
  }
  // 上面那一句是放好之后发出去的：再进新建页，什么都不该放
  const afterSendDraft = (await toNewPage()).value
  const afterSendChips = skillChips()
  // 点了没发：去设置页转一圈再回来，还是只有一份
  one<HTMLButtonElement>('.new-hero [data-act="assistant"]')?.click()
  await until('点了配置助手放好的技能片', () => skillChips() > 0)
  one<HTMLButtonElement>('.sb-settings')?.click()
  await until('设置页', () => one('.set-page'))
  const revisitDraft = (await toNewPage()).value
  const revisitChips = skillChips()

  return {
    step1: step1 !== null,
    listed,
    claudeButton,
    failure,
    failedLog,
    manual,
    docs,
    recheck,
    runningTail,
    step2,
    closed,
    draft,
    chip,
    stored,
    card,
    cardItems,
    reply: reply.slice(0, 200),
    command,
    eraseTitle,
    eraseItems,
    eraseReply: eraseReply.slice(-200),
    skin,
    reopened,
    reclosed,
    afterSendDraft,
    afterSendChips,
    revisitDraft,
    revisitChips,
  }
}

export function judgeOnboard(seen: OnboardProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(seen.step1, '首启引导的第一步没出来')
  for (const id of ['claude', 'codex', 'pi', 'dsh', 'gemini']) {
    must(seen.listed.includes(id), `第一步没列 ${id}：${seen.listed.join('、')}`)
  }
  must(seen.claudeButton.includes('2.1.282'), `Claude 的按钮不是装验证版：“${seen.claudeButton}”`)
  must(seen.failure.includes('EACCES'), `Codex 没装成的原因不对：“${seen.failure}”`)
  must(seen.failedLog.includes('npm error code EACCES'), '展开的日志里没有 npm 的报错')
  must(seen.manual.startsWith('npm install -g @openai/codex@'), `官方命令不对：“${seen.manual}”`)
  must(seen.docs.startsWith('https://'), `官方说明的链接不对：“${seen.docs}”`)
  must(seen.recheck, '回退里没有“装好后重新检测”')
  must(seen.runningTail.includes('Downloading'), `安装中没有日志末尾：“${seen.runningTail}”`)
  must(seen.step2, '装好之后没进第二步')
  must(seen.closed, '点了打开配置助手，引导没收起')
  must(seen.draft === '使用 Litch 产品手册帮我配置：', `输入框里是“${seen.draft}”`)
  must(seen.chip.includes('litch-manual'), `技能片不对：“${seen.chip}”`)
  must(seen.stored === 'done', `引导没记成走完：${seen.stored}`)
  must(
    seen.card.includes('Computer Use') && seen.card.includes('会话'),
    `确认卡没写清：“${seen.card}”`,
  )
  must(seen.cardItems === 'tool', `确认卡上的项不对：${seen.cardItems}`)
  must(seen.reply.includes('照你说的改好了'), '允许之后对话里没说改好了')
  must(
    seen.command.includes('litch config tools set local --computer on'),
    `过程区里没有那条命令：“${seen.command}”`,
  )
  must(seen.eraseTitle === '允许这次删除吗？', `删除卡的标题不对：“${seen.eraseTitle}”`)
  must(seen.eraseItems === 'erase', `删除卡上的项不对：${seen.eraseItems}`)
  must(seen.eraseReply.includes('没做成'), '拒绝之后对话里没说没做成')
  must(seen.skin === 'human', '换皮肤没照做')
  must(seen.reopened === 'assist', `设置页重新打开的引导不对：${seen.reopened}`)
  must(seen.reclosed, '重新打开的引导关不掉')
  must(
    seen.afterSendDraft === '' && seen.afterSendChips === 0,
    `发过之后再进新建页又预填了：“${seen.afterSendDraft}”，技能片 ${seen.afterSendChips} 个`,
  )
  must(
    seen.revisitDraft === '使用 Litch 产品手册帮我配置：' && seen.revisitChips === 1,
    `点了没发、去设置页再回来，预填不是一份：“${seen.revisitDraft}”，技能片 ${seen.revisitChips} 个`,
  )
  return failed
}
