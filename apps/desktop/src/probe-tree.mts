// 会话树的验收（对着模拟核心）：由 scripts/smoke.mjs --tree 起（npm run check:tree）。
// 模拟核心里说“派子会话”“提个子会话”“用子代理”各演一出（packages/core/src/mock/mock-tree.mts），这里照着点：
//   侧栏里子会话挂在父会话下面、能收起展开，子会话的行上只有状态点和名字；
//   派出卡片点了跳到子会话，子会话最上面一行写着由谁派出、点了回去，能脱离成独立会话；
//   注入的回报、唤醒画成系统提示条，不是用户的气泡，原文里的标签不露出来；
//   提案卡片（建议任务）在对话流里：等着的有“开始”“改了再开始”“不要”，开始了的能点进子会话，
//   过期了、撤回了的写着状态；侧面板的“建议任务”列全部，角标是等着的个数，点一条在对话里找到那张卡片；
//   收尾（wrap_up）带的建议照顺序一张一张、被拒的只一行原因，空的收尾不画；开始了的卡片写实际的 harness；
//   卡片和收尾的问题排在回合最下方（回答下面），过程里只留一行“建议”；点问题的回复按钮把它的话当用户消息发出，
//   之后问题折成一行写着回了哪个；卡片的“在这里做”在本会话发一条“在这里做：…”；“⋯”里关任务卡出可撤销的提示；
//   没调收尾时设备进程的提醒画成一行轻字，不是用户的气泡；
//   “新任务”出 offer 卡（“新会话 / 在这里做”），选新会话等模型补简报再写“已开始”、下面一行是子会话，
//   选在这里做写“在这里做”；侧面板里也有这一行和两个按钮；“交接”画成交给了分叉会话的卡，能点开；
//   子代理在对话流里一个一行（完成、已停止、失败以子线程为准），点了在侧面板里看子线程，失败的有红框写原话，
//   不接受直接输入的没有输入框；子代理线程不进侧栏；
//   三种皮肤、深浅两套下这几样东西不溢出。
// 下面的 treeProbe、treeLooks 会被原样送进页面里执行，不能引用函数外面的东西。
import type { BrowserWindow } from 'electron'

export interface TreeSeen {
  /** 派子会话：侧栏里两个子会话挂在父会话下面，行上只有状态点和名字 */
  nested: boolean
  bareRows: boolean
  /** 收起之后看不到子会话，箭头说“展开 2 个子会话”；再点展开回来 */
  folded: boolean
  unfolded: boolean
  /** 对话里两张派出卡片，点一张跳到那个子会话；最上面一行写着由父会话派出，点名字回去 */
  spawnCards: boolean
  jumped: boolean
  lineageBar: boolean
  jumpedBack: boolean
  /** 子会话都停下之后唤醒了父会话：一条系统提示，两条回报，没有用户气泡，标签原文不露出来 */
  wakeBar: boolean
  noRawTag: boolean
  /** 从菜单派一个不唤醒的：对话框挑 harness（换了别的就不能带上下文）、写第一段话，派出后选中它 */
  dialogFork: boolean
  dialogSpawned: boolean
  /** 它做完之后用户再说一句：回报是一条提示条，后面跟着用户自己的气泡 */
  notesBar: boolean
  /**
   * 提案：对话流里三张等着的卡片，侧面板角标 3；短的那张到点写“过期了”；“开始”起出子会话、卡片写“已开始”
   * 能点进去；“改了再开始”预填提案、提醒沙箱收不紧、改了标题再开始；再提一次，“不要”记成不要了；
   * “撤回提案”记成撤回了；侧面板里等着的在上，点一条对话里那张卡片闪一下
   */
  proposalShown: boolean
  proposalExpired: boolean
  proposalStarted: boolean
  proposalEdited: boolean
  proposalDismissed: boolean
  proposalWithdrawn: boolean
  proposalPanel: boolean
  /**
   * 收尾：一次调用两张等着的卡片加一行被拒的原因；空的收尾不画（撤回那个回合只有一个活动块）；
   * “改了再开始”能改“完成后唤醒”，换了 harness 开始后卡片写实际起出来的那个；
   * 没调收尾：提醒是一行轻字、没有用户气泡，后面跟着模型补的那张卡片
   */
  wrapShown: boolean
  wrapQuiet: boolean
  wrapActual: boolean
  /**
   * 收尾区：问题和卡片在回合最下方、回答下面，过程里那一步写“建议”；问题的回复按钮发出按钮的话，
   * 之后问题折成一行写着回了哪个；卡片的“在这里做”发一条“在这里做：…”、卡片写“在这里做”；
   * “⋯”里关任务卡出提示（设备服务有开关时是“已对 X 关闭任务卡 · 撤销 · 去设置”，撤销后提示收起；
   * 没有开关时说清楚要先升级）
   */
  tailBelow: boolean
  askShown: boolean
  askReplied: boolean
  wrapHere: boolean
  cardsOff: boolean
  /** 没调收尾时设备进程补的那一回合：不画提醒、气泡、过程和用时，只有补的那张卡片 */
  remindQuiet: boolean
  /**
   * offer 卡：对话流里一张“新会话 / 在这里做”的卡写着等你选，侧面板有这一行和两个按钮、角标算上它；
   * 选新会话先写等模型补简报，再写已开始、下面一行是起出来的子会话（侧栏里多一个）；
   * 再出一张，在侧面板里点在这里做，卡上写在这里做、不起子会话
   */
  offerShown: boolean
  offerStarted: boolean
  offerHere: boolean
  /** 交接：一张“交给了分叉会话”的卡，带着起出来的子会话（侧栏里挂在父会话下），能点开 */
  handOffCard: boolean
  /**
   * 子代理：对话流里每个子代理一行小条（不摊开任务说明），最后写着完成、已停止、失败（派出的条目报的一直是“在跑”，
   * 状态以子线程为准）；复古皮肤里状态写在方括号里；点了在侧面板里看，列表三行带状态，失败的那个有红框写着原话；
   * 不能直接输入的没有输入框，能的有；侧栏里没有子代理线程
   */
  agentCard: boolean
  agentStates: boolean
  agentBracket: boolean
  agentPanel: boolean
  agentFail: boolean
  agentMuted: boolean
  agentOpen: boolean
  agentsHidden: boolean
  /** 脱离：确认之后不再挂在父会话下面，最上面那一行也没了 */
  detached: boolean
  /** 看到的原样。判不过的时候靠它知道差在哪 */
  seen: Record<string, string>
}

export async function treeProbe(): Promise<TreeSeen> {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
  const until = async (check: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (check()) return true
      await sleep(50)
    }
    return check()
  }
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T & HTMLElement>(selector)
  const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  const seen: Record<string, string> = {}
  const PARENT = 's6'
  const kids = () => $$(`.row-line[data-parent="${PARENT}"]`)
  const idle = () => until(() => !$('.main .running-line'), 15000)
  const say = async (text: string) => {
    const box = $<HTMLTextAreaElement>('.main .dock textarea.cmp-text')
    if (!box) throw new Error('找不到输入框')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(80)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(200)
  }
  const select = async (sessionId: string) => {
    $(`.row-line[data-session="${sessionId}"] .ss-row`)?.click()
    await until(() => $('.main .dock textarea.cmp-text') !== null || $('.main .cmp.off') !== null)
    await sleep(200)
  }

  // —— 派子会话 ——
  await until(() => $(`.row-line[data-session="${PARENT}"]`) !== null, 20000)
  await select(PARENT)
  await say('派子会话去查一下')
  const nested = await until(() => kids().length === 2)
  const node = $(`.row-line[data-session="${PARENT}"]`)?.closest('.tree-node')
  const inside = kids().every((row) => node?.contains(row) && row.closest('.tree-kids') !== null)
  const bareRows = kids().every((row) => !row.querySelector('.chip, .time, .pill'))
  seen.kids = kids()
    .map((row) => row.textContent ?? '')
    .join(' | ')

  const fold = $(`.row-line[data-session="${PARENT}"] .tree-fold`)
  fold?.click()
  await sleep(150)
  const folded =
    kids().length === 0 &&
    fold?.getAttribute('aria-expanded') === 'false' &&
    (fold.getAttribute('aria-label') ?? '').includes('2')
  seen.fold = fold?.getAttribute('aria-label') ?? '没有箭头'
  fold?.click()
  await sleep(150)
  const unfolded = kids().length === 2

  // 唤醒：两个子会话都停下之后父会话被唤醒
  const wakeBar = await until(
    () => ($('.main .sev[data-event="wake"]')?.querySelectorAll('.sev-note').length ?? 0) === 2,
    15000,
  )
  await idle()
  const wakeTurn = $('.main .sev[data-event="wake"]')?.closest('.turn')
  const noBubble = wakeTurn ? wakeTurn.querySelector('.umsg') === null : false
  const noRawTag = !($('.main .tr')?.textContent ?? '').includes('litch-session-event')
  seen.wake = $('.main .sev[data-event="wake"]')?.textContent ?? '没有'

  const cards = $$('.main .tree-card[data-card="spawn"]')
  const spawnCards = cards.length === 2 && cards.every((card) => card.dataset.child)
  const childId = cards[0]?.dataset.child ?? ''
  cards[0]?.querySelector<HTMLElement>('button.tree-card-main')?.click()
  const jumped = await until(
    () => $('.ss-row.sel')?.closest('.row-line')?.getAttribute('data-session') === childId,
  )
  const lineageBar = await until(
    () => $(`.main .lineage[data-parent="${PARENT}"] .forked-link`) !== null,
  )
  seen.lineage = $('.main .lineage')?.textContent ?? '没有'
  $('.main .lineage .forked-link')?.click()
  const jumpedBack = await until(
    () => $('.ss-row.sel')?.closest('.row-line')?.getAttribute('data-session') === PARENT,
  )
  await sleep(200)

  // —— 从菜单派一个不唤醒的 ——
  const row = $(`.row-line[data-session="${PARENT}"]`)
  row?.querySelector<HTMLElement>('.row-more .ibtn')?.click()
  await sleep(200)
  const item = [...(row?.querySelectorAll<HTMLElement>('.pick-pop button') ?? [])].find((entry) =>
    (entry.textContent ?? '').includes('派出子会话'),
  )
  item?.click()
  await until(() => $('.spawn-dialog') !== null)
  const harness = $<HTMLSelectElement>('#spawn-harness')
  const choose = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  const other = [...(harness?.options ?? [])].find((option) => option.value !== harness?.value)
  if (harness && other) {
    choose?.call(harness, other.value)
    harness.dispatchEvent(new Event('change', { bubbles: true }))
  }
  await sleep(150)
  const dialogFork =
    $<HTMLInputElement>('input[name="spawn-kind"][value="fork"]')?.disabled === true
  const prompt = $<HTMLTextAreaElement>('#spawn-prompt')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    prompt,
    '把文档里的链接检查一遍',
  )
  prompt?.dispatchEvent(new Event('input', { bubbles: true }))
  const wake = $<HTMLInputElement>('.spawn-wake input')
  wake?.click()
  await sleep(100)
  $('.spawn-dialog button[type="submit"]')?.click()
  const dialogSpawned = await until(
    () =>
      $('.spawn-dialog') === null &&
      kids().length === 3 &&
      $('.ss-row.sel')?.closest('.row-line')?.getAttribute('data-parent') === PARENT,
  )
  // 它回完话（模拟核心照常回一句）之后回到父会话，再说一句
  await sleep(2500)
  await select(PARENT)
  await say('接着说')
  const notesBar = await until(() => {
    const bar = $$('.main .sev[data-event="notes"]').at(-1)
    const next = bar?.nextElementSibling
    return next?.classList.contains('umsg') === true && (next.textContent ?? '').includes('接着说')
  })
  await idle()

  // —— 提案（建议任务） ——
  const propCards = () => $$('.main [data-card="proposal"]')
  const states = () => propCards().map((card) => card.dataset.state ?? '')
  const badge = () => $('.side-tab[data-tab="proposals"] .side-badge')?.textContent ?? ''
  if ($('.side')?.hidden !== false) $('.tb-side')?.click()
  await until(() => $('.side')?.hidden === false)
  $('.side-tab[data-tab="proposals"]')?.click()
  await say('提个子会话')
  const proposalShown = await until(
    () =>
      states().join(',') === 'pending,pending,pending' &&
      badge() === '3' &&
      propCards().every((card) => card.querySelector('[data-act="start"]') !== null),
  )
  seen.proposal = propCards()[2]?.textContent ?? '没有'
  // 第二张八秒后过期
  const proposalExpired = await until(
    () =>
      states()[1] === 'expired' && badge() === '2' && !propCards()[1]?.querySelector('.prop-acts'),
    15000,
  )
  seen.expired = states().join(',')
  await idle()
  const before = kids().length
  propCards()[0]?.querySelector<HTMLElement>('[data-act="start"]')?.click()
  const proposalStarted = await until(
    () =>
      states()[0] === 'started' &&
      kids().length === before + 1 &&
      $('.main [data-card="proposal"][data-state="started"] button.prop-child:not(:disabled)') !==
        null,
  )
  await idle()
  await sleep(2500)
  await idle()

  // 改了再开始：第三张在 Pi 上，沙箱收不紧
  propCards()[2]?.querySelector<HTMLElement>('[data-act="edit"]')?.click()
  await until(() => $('.spawn-dialog[data-proposal]') !== null)
  const filled =
    $<HTMLSelectElement>('#spawn-harness')?.value === 'pi' &&
    ($<HTMLInputElement>('#spawn-cwd')?.value ?? '') !== '' &&
    $('.spawn-dialog .spawn-wider') !== null &&
    $<HTMLInputElement>('.spawn-dialog .spawn-wake input')?.checked === true
  seen.edit = `${$<HTMLSelectElement>('#spawn-harness')?.value} ${$('.spawn-dialog .spawn-wider')?.textContent ?? '没有提醒'}`
  const titleBox = $<HTMLInputElement>('#spawn-title')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
    titleBox,
    '改过标题的基准',
  )
  titleBox?.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(100)
  $('.spawn-dialog button[type="submit"]')?.click()
  const proposalEdited =
    filled &&
    (await until(
      () =>
        $('.spawn-dialog') === null &&
        states()[2] === 'started' &&
        kids().some((row) => (row.textContent ?? '').includes('改过标题的基准')),
    ))
  await idle()
  await sleep(2500)
  await idle()

  // 再提一次：“不要”记成不要了，“撤回提案”撤回最近一张还等着的
  await say('提个子会话')
  await until(() => propCards().length === 6)
  await idle()
  const left = kids().length
  propCards()[3]?.querySelector<HTMLElement>('[data-act="dismiss"]')?.click()
  const proposalDismissed = await until(() => states()[3] === 'dismissed' && kids().length === left)
  await say('撤回提案')
  const proposalWithdrawn = await until(() => states()[5] === 'withdrawn')
  await idle()
  seen.states = states().join(',')

  // 侧面板：等着的在上，了结的在下；点一条，对话里那张卡片闪一下
  const rows = $$('.side .prop-row')
  const order = rows.map((entry) => entry.dataset.state ?? '')
  // 短的那张这时可能也过期了：只看等着的都排在了结的前面
  const ordered = order.every(
    (state, index) => state !== 'pending' || order.slice(0, index).every((x) => x === 'pending'),
  )
  const picked = rows.at(-1)
  picked?.querySelector<HTMLElement>('.prop-row-main')?.click()
  const proposalPanel =
    ordered &&
    rows.length === 6 &&
    (await until(
      () =>
        $(`.main [data-proposal="${picked?.dataset.proposal ?? ''}"]`)?.hasAttribute(
          'data-flash',
        ) === true,
      2000,
    ))
  seen.panel = order.join(',')
  // 撤回的那个回合：撤回调用一段过程、回答，最后那次空的收尾不画（不会在回答后面再多一块）
  const lastTurn = $$('.main section.turn').at(-1)
  const wrapQuiet =
    lastTurn?.querySelectorAll('.proc').length === 1 &&
    lastTurn.querySelector('.wrap-cards') === null
  seen.quiet = `${lastTurn?.querySelectorAll('.proc').length ?? '没有'} 段过程`

  // —— 收尾带的建议 ——
  const wrapBox = () => $$('.main .wrap-cards').at(-1)
  await say('收尾建议')
  // 收尾带的卡片要等回合结束才出：等的这段时间里，回合在跑时卡片一次也不该露出来
  let wrapEarly = false
  const wrapShown = await until(() => {
    const running = $$('.main section.turn').at(-1)?.querySelector('.running-line') ?? null
    if (running !== null && wrapBox()?.closest('section.turn') === running.closest('section.turn'))
      wrapEarly = true
    const box = wrapBox()
    const parts = [...(box?.children ?? [])].map((part) =>
      part.classList.contains('prop-refused') ? 'refused' : (part as HTMLElement).dataset.state,
    )
    return parts.join(',') === 'pending,pending,refused' && !wrapEarly
  })
  seen.wrap = wrapBox()?.textContent ?? '没有'
  await idle()
  const wrapTurn = wrapBox()?.closest('section.turn')
  const tail = wrapTurn?.querySelector<HTMLElement>('.turn-tail')
  // 回合结束后过程收成了“已处理”一行：点开看里面那一步
  const procHead = wrapTurn?.querySelector<HTMLElement>('.proc-head[aria-expanded="false"]')
  procHead?.click()
  await sleep(150)
  // 收尾区在回答下面：它前面是回答（不是过程），后面最多是回合的尾巴；过程里那一步写“建议”
  const tailBelow =
    tail?.contains(wrapBox() ?? null) === true &&
    tail.previousElementSibling !== null &&
    !tail.previousElementSibling.classList.contains('proc') &&
    (tail.nextElementSibling === null ||
      tail.nextElementSibling.matches('.turn-foot, .running-line')) &&
    (wrapTurn?.querySelector('.proc')?.textContent ?? '').includes('建议')
  seen.tail = `${tail?.previousElementSibling?.className ?? '没有'} | ${wrapTurn?.querySelector('.proc')?.textContent ?? '没有过程'}`
  const askBox = () => wrapTurn?.querySelector<HTMLElement>('.turn-tail .tail-ask')
  const askShown =
    askBox()?.dataset.state === 'open' &&
    (askBox()?.querySelectorAll('button[data-act]').length ?? 0) === 2 &&
    (askBox()?.textContent ?? '').includes('解析器的单测')
  askBox()?.querySelector<HTMLElement>('button[data-act="0"]')?.click()
  const askReplied = await until(() => {
    const said = $$('.main .umsg').at(-1)?.textContent ?? ''
    return (
      said.includes('在这里把解析器的单测补齐') &&
      askBox()?.dataset.state === 'past' &&
      (askBox()?.textContent ?? '').includes('在这里补')
    )
  })
  seen.ask = askBox()?.textContent ?? '没有'
  await idle()
  const firstWrap = () => wrapBox()?.querySelector<HTMLElement>('[data-card="proposal"]')
  firstWrap()?.querySelector<HTMLElement>('[data-act="edit"]')?.click()
  await until(() => $('.spawn-dialog[data-proposal]') !== null)
  const harnessBox = $<HTMLSelectElement>('#spawn-harness')
  if (harnessBox) {
    harnessBox.value = 'pi'
    harnessBox.dispatchEvent(new Event('change', { bubbles: true }))
  }
  $<HTMLInputElement>('.spawn-dialog .spawn-wake input')?.click()
  await sleep(100)
  const wakeOff = $<HTMLInputElement>('.spawn-dialog .spawn-wake input')?.checked === false
  $('.spawn-dialog button[type="submit"]')?.click()
  const wrapActual =
    wakeOff &&
    (await until(() => {
      const card = firstWrap()
      const meta = card?.querySelector<HTMLElement>('.prop-meta')
      return (
        card?.dataset.state === 'started' &&
        meta?.dataset.actual === 'true' &&
        meta.querySelector('[data-harness="pi"]') !== null
      )
    }))
  seen.actual = firstWrap()?.querySelector('.prop-meta')?.textContent ?? '没有'
  await idle()
  await sleep(2500)
  await idle()

  // 第二张在这里做：本会话里发一条“在这里做：标题…”，卡片写“在这里做”、不起子会话
  const hereLeft = kids().length
  const secondWrap = () => wrapBox()?.querySelectorAll<HTMLElement>('[data-card="proposal"]')[1]
  secondWrap()?.querySelector<HTMLElement>('[data-act="here"]')?.click()
  const wrapHere = await until(
    () =>
      secondWrap()?.dataset.state === 'here' &&
      ($$('.main .umsg').at(-1)?.textContent ?? '').startsWith('在这里做：在 Pi 上对一遍文案') &&
      kids().length === hereLeft,
  )
  seen.here = `${secondWrap()?.dataset.state} ${$$('.main .umsg').at(-1)?.textContent ?? ''}`
  await idle()

  // “⋯”里关任务卡
  const toastText = () => $('.toasts .toast-text')?.textContent ?? ''
  secondWrap()?.querySelector<HTMLElement>('[data-act="more"]')?.click()
  await until(() => $('.prop-menu [data-option="cardsOff"]') !== null)
  const offLabel = $('.prop-menu [data-option="cardsOff"]')?.textContent ?? ''
  $('.prop-menu [data-option="cardsOff"]')?.click()
  await until(() => toastText() !== '')
  seen.cardsOff = `${offLabel} → ${toastText()}`
  let cardsOff = /在 .+ 上关闭 Claude Code 的任务卡/.test(offLabel)
  if (toastText().startsWith('已关闭 Claude Code 的任务卡')) {
    const undo = [...document.querySelectorAll<HTMLElement>('.toasts .toast-act')]
    cardsOff &&=
      undo.map((button) => button.textContent).join(',') === '撤销,前往设置' &&
      secondWrap()?.dataset.state === 'here'
    undo[0]?.click()
    cardsOff &&= await until(() => toastText() === '')
  } else {
    cardsOff &&= toastText().includes('任务卡开关')
    $<HTMLElement>('.toasts .toast-x')?.click()
  }

  // —— 没调收尾：提醒 ——
  // 设备进程替用户提醒模型补调收尾的那一回合对用户透明：不画提醒那一行、用户气泡、过程和用时，
  // 只剩补调收尾带出来的那张卡片，看着就接在上一回合下面
  await say('忘了收尾')
  const remindTurn = () => {
    const turns = $$('.main section.turn')
    const asked = turns.findIndex((turn) =>
      turn.querySelector('.umsg')?.textContent?.includes('忘了收尾'),
    )
    return asked < 0 ? undefined : turns[asked + 1]
  }
  const remindQuiet = await until(() => {
    const turn = remindTurn()
    return (
      turn !== undefined &&
      $('.main .sev[data-event="remind"]') === null &&
      [...turn.children].every((child) => child.matches('.turn-tail')) &&
      turn.querySelectorAll('.wrap-cards [data-card="proposal"]').length === 1
    )
  })
  seen.remind =
    [...(remindTurn()?.children ?? [])].map((child) => child.className).join('|') || '没有'
  await idle()

  // —— offer 卡：新会话 ——
  const offerCard = () => $$('.main [data-card="offer"]').at(-1)
  const offerKids = kids().length
  await say('新任务：给设置页加导出按钮')
  const offerShown = await until(() => {
    const card = offerCard()
    return (
      card?.dataset.state === 'offered' &&
      card.querySelector('[data-act="session"]') !== null &&
      card.querySelector('[data-act="here"]') !== null &&
      card.querySelector('.prop-ask') !== null &&
      $('.side .prop-row[data-offer][data-state="offered"] [data-act="session"]') !== null &&
      ($('.side .side-badge')?.textContent ?? '') !== ''
    )
  })
  seen.offer = offerCard()?.textContent ?? '没有'
  offerCard()?.querySelector<HTMLElement>('[data-act="session"]')?.click()
  const chosen = await until(() => {
    const state = offerCard()?.dataset.state
    return state === 'chosen' || state === 'started'
  })
  const offerStarted =
    chosen &&
    (await until(() => {
      const card = offerCard()
      const child = card?.querySelector<HTMLElement>('.prop-child')?.dataset.child ?? ''
      return (
        card?.dataset.state === 'started' &&
        child !== '' &&
        card.querySelector('.prop-brief') !== null &&
        kids().length === offerKids + 1 &&
        $(`.row-line[data-session="${child}"]`) !== null
      )
    }))
  seen.offerStarted = `${offerCard()?.dataset.state} ${offerCard()?.textContent ?? ''}`
  await idle()
  await sleep(2500)
  await idle()

  // —— offer 卡：在这里做（在侧面板里点） ——
  const offersBefore = $$('.main [data-card="offer"]').length
  await say('另一个新任务：整理日志')
  await until(
    () =>
      $$('.main [data-card="offer"]').length === offersBefore + 1 &&
      $('.side .prop-row[data-state="offered"] [data-act="here"]') !== null,
  )
  const hereKids = kids().length
  $('.side .prop-row[data-state="offered"] [data-act="here"]')?.click()
  const offerHere = await until(
    () =>
      offerCard()?.dataset.state === 'here' &&
      offerCard()?.querySelector('[data-act]') === null &&
      $('.side .prop-row[data-state="offered"]') === null &&
      $('.side .prop-row[data-state="here"]') !== null,
  )
  await idle()
  const hereNoChild = kids().length === hereKids
  seen.offerHere = `${offerCard()?.dataset.state} ${kids().length - hereKids} 个新子会话`

  // —— 交接 ——
  const handKids = kids().length
  await say('先交接手上的活，再回答我一个问题')
  const handOffCard = await until(() => {
    const card = $$('.main [data-card="hand-off"]').at(-1)
    const child = card?.dataset.child ?? ''
    return (
      child !== '' &&
      card?.querySelector('button.tree-card-main') !== null &&
      kids().length === handKids + 1 &&
      $(`.row-line[data-session="${child}"]`) !== null
    )
  })
  seen.handOff = $$('.main [data-card="hand-off"]').at(-1)?.textContent ?? '没有'
  await idle()
  await sleep(2500)
  await idle()
  $('.side [data-tool="hide"]')?.click()

  // —— 子代理 ——
  await say('用子代理看看')
  const rowsOf = () => $$('.main .agents-rows[data-card="agents"] .agent-row')
  const agentCard = await until(
    () =>
      rowsOf().length === 3 &&
      rowsOf().every((row) => row.querySelector('.agent-st') !== null) &&
      // 任务说明不摊开：行上只有一句描述
      !($('.main .agents-rows[data-card="agents"]')?.textContent ?? '').includes('入口文件的路径'),
  )
  const agentStates = await until(
    () =>
      rowsOf()
        .map((row) => row.dataset.state)
        .join(',') === 'completed,stopped,failed',
    12000,
  )
  const agents = rowsOf()
  const ids = agents.map((entry) => entry.dataset.agent ?? '')
  seen.agents = agents.map((entry) => entry.textContent ?? '').join(' | ')
  const mark = agents[0]?.querySelector('.agent-st')
  const bracket = mark ? getComputedStyle(mark, '::before').content : ''
  const agentBracket = document.documentElement.dataset.skin !== 'retro' || bracket === '"["'
  seen.bracket = `${document.documentElement.dataset.skin ?? ''} ${bracket}`
  agents[2]?.click()
  const agentPanel = await until(
    () =>
      $('.side')?.hidden === false &&
      $$('.side .agents-pick').length === 3 &&
      $(`.side .agents-pick[data-agent="${ids[2]}"]`)?.getAttribute('aria-selected') === 'true' &&
      $(`.side .agents-view[data-agent="${ids[2]}"] .tr .turn`) !== null,
  )
  const agentFail = await until(() =>
    ($(`.side .agents-view[data-agent="${ids[2]}"] .agents-fail`)?.textContent ?? '').includes(
      'PreToolUse:Agent hook error',
    ),
  )
  seen.fail = $('.side .agents-fail')?.textContent ?? '没有'
  $(`.side .agents-pick[data-agent="${ids[1]}"]`)?.click()
  await until(() => $(`.side .agents-view[data-agent="${ids[1]}"] .tr .turn`) !== null)
  const agentMuted =
    $('.side .agents-view .dock textarea') === null &&
    ($('.side .agents-view .cmp.off')?.textContent ?? '') !== ''
  seen.muted = $('.side .agents-view .dock')?.textContent ?? '没有'
  $(`.side .agents-pick[data-agent="${ids[0]}"]`)?.click()
  const agentOpen = await until(
    () => $(`.side .agents-view[data-agent="${ids[0]}"] .dock textarea`) !== null,
  )
  const agentsHidden = ids.every((id) => $(`.row-line[data-session="${id}"]`) === null)
  $('.side [data-tool="hide"]')?.click()

  // —— 脱离 ——
  const target = kids()[0]?.getAttribute('data-session') ?? ''
  await select(target)
  await until(() => $('.main .lineage [data-act="detach"]') !== null)
  $('.main .lineage [data-act="detach"]')?.click()
  await until(() => $('dialog.confirm') !== null)
  $('dialog.confirm .confirm-yes')?.click()
  const detached = await until(
    () =>
      $('.main .lineage') === null &&
      $(`.row-line[data-session="${target}"]`) !== null &&
      $(`.row-line[data-session="${target}"]`)?.getAttribute('data-parent') === null,
  )

  return {
    nested: nested && inside,
    bareRows,
    folded,
    unfolded,
    spawnCards,
    jumped,
    lineageBar,
    jumpedBack,
    wakeBar: wakeBar && noBubble,
    noRawTag,
    dialogFork,
    dialogSpawned,
    notesBar,
    proposalShown,
    proposalExpired,
    proposalStarted,
    proposalEdited,
    proposalDismissed,
    proposalWithdrawn,
    proposalPanel,
    wrapShown,
    wrapQuiet,
    wrapActual,
    tailBelow,
    askShown,
    askReplied,
    wrapHere,
    cardsOff,
    remindQuiet,
    offerShown,
    offerStarted,
    offerHere: offerHere && hereNoChild,
    handOffCard,
    agentCard,
    agentStates,
    agentBracket,
    agentPanel,
    agentFail,
    agentMuted,
    agentOpen,
    agentsHidden,
    detached,
    seen,
  }
}

export interface TreeLooks {
  /** 每种皮肤、深浅：几样东西有没有溢出（内容比框宽、框伸出对话区），看不看得见 */
  rows: { look: string; overflow: string[]; hidden: string[] }[]
}

/** 三种皮肤乘深浅：卡片、提示条、子会话那一行、侧栏里嵌套的行。先把父会话打开，留着上面演过的东西 */
export async function treeLooks(parent: string): Promise<TreeLooks> {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
  document.querySelector<HTMLElement>(`.row-line[data-session="${parent}"] .ss-row`)?.click()
  await sleep(600)
  // 回合结束后整段过程收成一行，子代理那一行在过程里跟着收起：先把收起的过程都点开
  for (const head of document.querySelectorAll<HTMLElement>(
    '.main .proc-head[aria-expanded="false"]',
  ))
    head.click()
  await sleep(200)
  const root = document.documentElement
  const was = { skin: root.dataset.skin, theme: root.dataset.theme }
  const rows: TreeLooks['rows'] = []
  const parts = [
    '.tree-card',
    '.agent-row',
    '.prop-card',
    '.prop-refused',
    '.turn-tail',
    '.tail-ask',
    '.prop-menu .ibtn',
    '.sev',
    '.tree-kids .row-line',
    '.tree-fold',
  ]
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      root.dataset.skin = skin
      root.dataset.theme = theme
      await sleep(120)
      const overflow: string[] = []
      const hidden: string[] = []
      const frame = document.querySelector('.main .tr')?.getBoundingClientRect()
      for (const selector of parts) {
        const found = [...document.querySelectorAll<HTMLElement>(selector)]
        if (found.length === 0) hidden.push(`${selector} 没有`)
        for (const element of found) {
          const box = element.getBoundingClientRect()
          if (box.width === 0 || box.height === 0) hidden.push(selector)
          if (element.scrollWidth > element.clientWidth + 1) overflow.push(`${selector} 内容比框宽`)
          if (frame && element.closest('.main') && box.right > frame.right + 1) {
            overflow.push(`${selector} 伸出对话区`)
          }
          const style = getComputedStyle(element)
          if (style.color === style.backgroundColor) hidden.push(`${selector} 字和底一个颜色`)
        }
      }
      rows.push({ look: `${skin}/${theme}`, overflow, hidden })
    }
  }
  if (was.skin) root.dataset.skin = was.skin
  if (was.theme) root.dataset.theme = was.theme
  else delete root.dataset.theme
  return { rows }
}

const LABELS: Record<Exclude<keyof TreeSeen, 'seen'>, string> = {
  nested: '派出的两个子会话挂在父会话下面',
  bareRows: '子会话的行上只有状态点和名字',
  folded: '收起之后子会话不见了，箭头写着展开几个',
  unfolded: '再点一下展开回来',
  spawnCards: '对话里两张派出卡片',
  jumped: '点派出卡片跳到子会话',
  lineageBar: '子会话最上面一行写着由父会话派出',
  jumpedBack: '点父会话的名字回去',
  wakeBar: '唤醒画成系统提示条（两条回报、没有用户气泡）',
  noRawTag: '注入的标签原文不露出来',
  dialogFork: '派子会话的对话框里换了 harness 就不能带上下文',
  dialogSpawned: '从菜单派出的子会话挂在父会话下面并被选中',
  notesBar: '回报附在下一条消息前面：提示条加用户自己的气泡',
  proposalShown: '对话流里三张等着的提案卡片，侧面板角标 3',
  proposalExpired: '短的那张提案到点写“过期了”、没有按钮，角标变 2',
  proposalStarted: '点“开始”起出子会话，卡片写“已开始”、能点进去',
  proposalEdited: '“改了再开始”照提案预填、提醒沙箱收不紧，改了标题再开始',
  proposalDismissed: '点“不要”记成不要了，不起子会话',
  proposalWithdrawn: '模型撤回的提案写“撤回了”',
  proposalPanel: '侧面板等着的在上、了结的在下，点一条对话里那张卡片闪一下',
  wrapShown: '收尾带的三条建议：两张等着的卡片加一行被拒的原因，回合结束才出',
  wrapQuiet: '空的收尾不画：撤回的那个回合只有一个活动块',
  wrapActual: '“改了再开始”能改完成后唤醒；换了 harness 开始后卡片写实际的 harness',
  tailBelow: '收尾区在回合最下方、回答下面，过程里那一步写“建议”',
  askShown: '收尾的问题带两个回复按钮',
  askReplied: '点回复按钮发出按钮的话，问题折成一行写着回了哪个',
  wrapHere: '卡片的“在这里做”在本会话发“在这里做：…”，卡片写在这里做、不起子会话',
  cardsOff: '“⋯”里关任务卡：提示可撤销（或说清楚设备服务还没有开关）',
  remindQuiet: '没调收尾时补的那一回合只有补的那张卡片，不画提醒、用户气泡、过程和用时',
  offerShown: '“新任务”出 offer 卡：等你选、两个按钮，侧面板有这一行和按钮、角标算上它',
  offerStarted:
    'offer 卡选新会话：先等模型补简报，再写已开始、带简报，下面一行是侧栏里新多的子会话',
  offerHere: '侧面板里点“在这里做”：卡上写在这里做、按钮没了，不起子会话',
  handOffCard: '“交接”画成交给了分叉会话的卡，能点开，子会话挂在父会话下',
  agentCard: '对话流里三个子代理各一行小条，不摊开任务说明',
  agentStates: '子代理行最后写着完成、已停止、失败（以子线程为准）',
  agentBracket: '复古皮肤里子代理的状态写在方括号里',
  agentPanel: '点子代理在侧面板里看它：列表三行，选中的是它，下面是它的对话',
  agentFail: '失败的子代理有红框写着 harness 的原话',
  agentMuted: '不接受直接输入的子代理没有输入框',
  agentOpen: '接受直接输入的子代理有输入框',
  agentsHidden: '子代理线程不进侧栏',
  detached: '脱离之后不再挂在父会话下面',
}

export function judgeTree(seen: TreeSeen, looks: TreeLooks): string[] {
  const failed: string[] = []
  for (const [key, label] of Object.entries(LABELS)) {
    if (seen[key as keyof typeof LABELS] !== true) failed.push(label)
  }
  for (const row of looks.rows) {
    if (row.overflow.length > 0)
      failed.push(`${row.look}：${[...new Set(row.overflow)].join('、')}`)
    if (row.hidden.length > 0) failed.push(`${row.look}：${[...new Set(row.hidden)].join('、')}`)
  }
  return failed
}

/** 在同一个窗口里先演一遍，再换皮肤看样子 */
export async function runTreeChecks(window: BrowserWindow): Promise<readonly [object, string[]]> {
  const inPage = async <T, A extends unknown[]>(
    probe: (...args: A) => Promise<T>,
    ...args: A
  ): Promise<T> => {
    const list = args.map((arg) => JSON.stringify(arg)).join(', ')
    return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
  }
  const seen = await inPage(treeProbe)
  const looks = await inPage(treeLooks, 's6')
  return [{ ...seen, looks }, judgeTree(seen, looks)]
}
