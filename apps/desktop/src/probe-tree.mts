// 会话树的验收（对着模拟核心）：由 scripts/smoke.mjs --tree 起（npm run check:tree）。
// 模拟核心里说“派子会话”“提个子会话”“用子代理”各演一出（packages/core/src/mock/mock-tree.mts），这里照着点：
//   侧栏里子会话挂在父会话下面、能收起展开，子会话的行上只有状态点和名字；
//   派出卡片点了跳到子会话，子会话最上面一行写着由谁派出、点了回去，能脱离成独立会话；
//   注入的回报、唤醒画成系统提示条，不是用户的气泡，原文里的标签不露出来；
//   提案卡片（建议任务）在对话流里：等着的有“开始”“改了再开始”“不要”，开始了的能点进子会话，
//   过期了、撤回了的写着状态；侧面板的“建议任务”列全部，角标是等着的个数，点一条在对话里找到那张卡片；
//   子代理卡片点了在侧面板里看子线程，不接受直接输入的没有输入框；子代理线程不进侧栏；
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
  /** 子代理：卡片两行，点了在侧面板里看；不能直接输入的没有输入框，能的有；侧栏里没有子代理线程 */
  agentCard: boolean
  agentPanel: boolean
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
    (entry.textContent ?? '').includes('派一个子会话'),
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
    $('.spawn-dialog .spawn-wake') === null
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
  $('.side [data-tool="hide"]')?.click()

  // —— 子代理 ——
  await say('用子代理看看')
  const agentCard = await until(
    () => $$('.main .tree-card[data-card="agents"] .tree-agent').length === 2,
  )
  await until(() =>
    $$('.main .tree-card[data-card="agents"] .tree-card-state').every(
      (state) => state.textContent === '做完了',
    ),
  )
  const agents = $$('.main .tree-card[data-card="agents"] .tree-agent')
  const ids = agents.map((entry) => entry.dataset.agent ?? '')
  seen.agents = agents.map((entry) => entry.textContent ?? '').join(' | ')
  agents[1]?.click()
  const agentPanel = await until(
    () =>
      $('.side')?.hidden === false &&
      $(`.side .agents-view[data-agent="${ids[1]}"] .tr .turn`) !== null,
  )
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
    agentCard,
    agentPanel,
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
  const root = document.documentElement
  const was = { skin: root.dataset.skin, theme: root.dataset.theme }
  const rows: TreeLooks['rows'] = []
  const parts = ['.tree-card', '.prop-card', '.sev', '.tree-kids .row-line', '.tree-fold']
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
  agentCard: '子代理卡片列出两个子代理',
  agentPanel: '点子代理在侧面板里看它的对话',
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
