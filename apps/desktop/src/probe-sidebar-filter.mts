// 侧栏验收：只看某几个 harness 的会话。对着模拟核心：本机和 build-01 上各有四个 harness 的会话，
// nas 上只有 Codex 的，gpu-box 没连着（留着一个 Pi 的、一个 Claude Code 的）。
// 和别的验收一样，这里的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 量到的东西怎么算合格在 probe-sidebar-filter-judge.mts。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

/** 各台设备下面的东西，按设备标识分开 */
type PerDevice = Record<string, string[]>

export interface FilterSeen {
  /** 没筛的时候：入口在，“正在只看”那一行不在 */
  entry: boolean
  quietAtStart: boolean
  /** 点开入口：能挑的（harness 的标识，“全部”是空的）；一开始选中的是哪个；焦点落在哪个上 */
  options: string[]
  chosenAtStart: string
  focusAtStart: string
  /** 按 Esc：收起，焦点回到入口上 */
  escaped: boolean
  /** 画出来的会话，一行一句：标题｜徽标｜等人｜选中。没筛的时候、只看 Pi 之后（这时开着一个 Claude Code 的会话） */
  before: PerDevice
  after: PerDevice
  /** 画出来的各组（和数据副本里分组的键一样），筛之前、之后 */
  groupsBefore: PerDevice
  groupsAfter: PerDevice
  /** 筛了之后一个会话都不剩的设备上写的那一句（没有就是空的） */
  none: PerDevice
  /** 会话全被筛掉的项目、组里那一句：所在组｜字｜带不带“关闭筛选” */
  hid: PerDevice
  /** 再只看 Pi，点 nas 上那一句的“关闭筛选”：筛选没了 */
  offClicked: boolean
  /** 本机的 docs-site：筛之前有“展示更多”，筛之后没有了（剩下的不到一屏） */
  moreBefore: boolean
  moreAfter: boolean
  /** 挑了 Pi 之后选项没有收起（能接着挑）；按 Esc 收起 */
  stayed: boolean
  /** “正在只看”那一行：徽标｜字；入口是不是画成开着的；记在界面本地的是哪几个（逗号连起来） */
  line: string
  entryOn: boolean
  saved: string | null
  /** 开着的那个会话不是 Pi 的，筛的时候留着；到别处去之后它就不在了 */
  pickedGone: boolean
  /** 筛着的时候收起本机的 litch：行上的汇总（Claude Code 那个在跑的不算了，等审批的还算） */
  tally: string
  /** 六套皮肤明暗：哪里｜那一行的字和底的对比度｜入口和底的对比度｜顶上那一块横向溢出｜那一行多高 */
  skins: string[]
  /** 再挑上 Codex：“正在只看”那一行（徽标们｜字）、记着的、本机下面画出来的会话 */
  twoLine: string
  twoSaved: string | null
  twoRows: string[]
  /** 点一下那一行：筛选没了，树里和筛之前一样 */
  cleared: boolean
  restored: PerDevice
  savedAfter: string | null
}

export async function filterSeen(session: string): Promise<FilterSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, text, until } = kit
  const DEVICES = ['local', 'build', 'nas', 'gpu']
  const each = (read: (deviceId: string) => string[]): PerDevice =>
    Object.fromEntries(DEVICES.map((deviceId) => [deviceId, read(deviceId)]))
  const rows = () =>
    each((deviceId) =>
      all('.ss-row', kit.device(deviceId)).map((row) =>
        [
          text(one('.title', row)),
          text(one('.chip', row)),
          one('.pill.wait', row) ? '等人' : '',
          row.classList.contains('sel') ? '选中' : '',
        ].join('｜'),
      ),
    )
  const groups = () =>
    each((deviceId) =>
      all('[data-group]', kit.device(deviceId)).map((group) => group.dataset.group ?? ''),
    )
  const saved = () => {
    const kept = (
      JSON.parse(localStorage.getItem('litch.sidebar') ?? '{}') as { harnesses?: string[] }
    ).harnesses
    return kept && kept.length > 0 ? kept.join(',') : null
  }
  const entry = () => one<HTMLButtonElement>('.sb-filter > .ibtn')
  const line = () => one<HTMLButtonElement>('.sb-filter-on')
  const more = () => Boolean(one('[data-group="docs"] .ss-more .more', kit.device('local')))
  const toNewPage = async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', metaKey: true, bubbles: true }),
    )
    await until('新建对话页', () => one('.new-hero') && !one('.ss-row.sel'))
    await kit.frame()
  }
  const openChoices = async () => {
    ;(await until('筛选的入口', entry)).click()
    return until('筛选的选项', () => one('.sb-filter .pick-pop'), 5000)
  }

  // ---- 一、没筛的时候 ----
  await toNewPage()
  await until('侧栏里的会话', () => kit.titles('local').length >= 5 && kit.titles('build').length)
  const before = rows()
  const groupsBefore = groups()
  const moreBefore = more()
  const quietAtStart = !line()
  const hasEntry = Boolean(entry())

  // ---- 二、点开入口：能挑哪些；Esc 收起 ----
  let pop = await openChoices()
  const options = all('[role="option"]', pop).map((option) => option.dataset.harness ?? '?')
  const chosenAtStart = one('[aria-selected="true"]', pop)?.dataset.harness ?? '?'
  const focusAtStart = (document.activeElement as HTMLElement | null)?.dataset.harness ?? '?'
  kit.press(document.activeElement ?? pop, 'Escape')
  const escaped =
    (await kit.seen(() => !one('.sb-filter .pick-pop'), 3000)) && document.activeElement === entry()

  // ---- 三、开着一个 Claude Code 的会话，挑 Pi ----
  await kit.open(session)
  pop = await openChoices()
  one<HTMLButtonElement>('[data-harness="pi"]', pop)?.click()
  const shownLine = await until('“正在只看”那一行', line, 5000)
  // 多选：挑了一个不收起，按 Esc 才收
  await kit.frame()
  const stayed = Boolean(one('.sb-filter .pick-pop'))
  kit.press(document.activeElement ?? pop, 'Escape')
  await kit.seen(() => !one('.sb-filter .pick-pop'), 3000)
  await until('树跟着筛了', () => !kit.row('把运行时与 SSH 入口的启动拆开'), 5000)
  await kit.frame()
  const after = rows()
  const groupsAfter = groups()
  const none = each((deviceId) => all('.dev-none', kit.device(deviceId)).map(text))
  const hid = each((deviceId) =>
    all('.filter-hid', kit.device(deviceId)).map((note) =>
      [
        note.closest<HTMLElement>('[data-group]')?.dataset.group ?? '?',
        text(one('.filter-hid-text', note)),
        one('.filter-off', note) ? '关闭筛选' : '',
      ].join('｜'),
    ),
  )
  const moreAfter = more()
  const said = `${text(one('.chip', shownLine))}｜${text(one('.ell', shownLine))}`
  const entryOn = entry()?.classList.contains('on') ?? false
  const savedOn = saved()

  // ---- 四、六套皮肤：那一行看得清、不溢出 ----
  // 那一行的底是半透明的：对比度按叠出来的实际颜色算（kit.backdrop）
  const skins = await kit.eachSkin((where) => {
    const bar = line() as HTMLElement
    const label = one('.ell', bar) as HTMLElement
    const button = entry() as HTMLElement
    const top = one('.sb-top') as HTMLElement
    return [
      where,
      kit.contrast(getComputedStyle(label).color, kit.backdrop(bar)).toFixed(1),
      kit.contrast(getComputedStyle(button).color, kit.backdrop(button)).toFixed(1),
      top.scrollWidth - top.clientWidth,
      bar.offsetHeight,
    ].join('｜')
  })

  // ---- 五、到别处去：开着的那个不是 Pi 的，这下不在了。收起 litch 看汇总 ----
  await toNewPage()
  const pickedGone = await kit.seen(() => !kit.row(session), 3000)
  const litch = () => kit.workspaceLine('local', 'litch')
  await kit.fold(litch(), false)
  const mark = await until('收起的项目上的汇总', () => one<HTMLElement>('.tally', litch()), 5000)
  const { approval, answer, running, unread } = mark.dataset
  const tally = [
    text(one('.pill.wait', mark)),
    one('.st.run', mark) ? '在跑' : '',
    one('.st.unread', mark) ? '未读' : '',
    `${approval}/${answer}/${running}/${unread}`,
  ].join('｜')
  await kit.fold(litch(), true)

  // ---- 六、再挑上 Codex：两家的都留着 ----
  pop = await openChoices()
  one<HTMLButtonElement>('[data-harness="codex"]', pop)?.click()
  await until('挑了两个', () => line()?.dataset.harness === 'pi,codex', 5000)
  kit.press(document.activeElement ?? pop, 'Escape')
  await kit.seen(() => !one('.sb-filter .pick-pop'), 3000)
  await kit.frame()
  const two = line() as HTMLElement
  const twoLine = `${all('.chip', two).map(text).join(' ')}｜${text(one('.ell', two))}`
  const twoSaved = saved()
  const twoRows = rows().local ?? []

  // ---- 七、点一下那一行：取消 ----
  line()?.click()
  const cleared = await kit.seen(() => !line() && !entry()?.classList.contains('on'), 3000)
  await until('树回到没筛的样子', () => kit.row('把运行时与 SSH 入口的启动拆开'), 5000)
  await kit.frame()
  const restored = rows()
  const savedAfter = saved()

  // ---- 八、再只看 Pi，点项目里那一句的“关闭筛选” ----
  pop = await openChoices()
  one<HTMLButtonElement>('[data-harness="pi"]', pop)?.click()
  await until('又只看 Pi', () => line()?.dataset.harness === 'pi', 5000)
  kit.press(document.activeElement ?? pop, 'Escape')
  await kit.seen(() => !one('.sb-filter .pick-pop'), 3000)
  ;(
    await until(
      'nas 上那一句',
      () => one<HTMLButtonElement>('.filter-off', kit.device('nas')),
      5000,
    )
  ).click()
  const offClicked =
    (await kit.seen(() => !line() && !one('.filter-hid'), 3000)) && saved() === null
  await kit.frame()

  return {
    entry: hasEntry,
    quietAtStart,
    options,
    chosenAtStart,
    focusAtStart,
    escaped,
    before,
    after,
    groupsBefore,
    groupsAfter,
    none,
    hid,
    offClicked,
    moreBefore,
    moreAfter,
    stayed,
    line: said,
    entryOn,
    saved: savedOn,
    pickedGone,
    tally,
    skins,
    twoLine,
    twoSaved,
    twoRows,
    cleared,
    restored,
    savedAfter,
  }
}

/** 挑一个 harness 只看它（null 是取消），等树跟上。重开应用之前、截图之前用。从没筛的时候起挑 */
export async function filterTo(harness: string | null): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, until } = kit
  const now = () => one('.sb-filter-on')?.dataset.harness ?? null
  if (now() === harness) return
  ;(await until('筛选的入口', () => one<HTMLButtonElement>('.sb-filter > .ibtn'))).click()
  const pop = await until('筛选的选项', () => one('.sb-filter .pick-pop'), 5000)
  one<HTMLButtonElement>(`[data-harness="${harness ?? ''}"]`, pop)?.click()
  await until('筛选换过去', () => now() === harness, 5000)
  // 挑一个 harness 时选项不收（多选），收起来
  if (one('.sb-filter .pick-pop')) kit.press(document.activeElement ?? pop, 'Escape')
  await kit.seen(() => !one('.sb-filter .pick-pop'), 3000)
  await kit.frame()
}

export interface FilterKept {
  /** 应用重开之后：“正在只看”那一行还在，写的是什么 */
  line: string
  /** 本机下面画出来的会话（标题｜徽标｜等人） */
  rows: string[]
}

/** 页面重新加载之后（核心重启）、侧栏已经展开：上次挑的还记得没有。看完把它取消 */
export async function filterKept(): Promise<FilterKept> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, text, until } = kit
  const bar = one<HTMLButtonElement>('.sb-filter-on')
  const line = bar ? `${bar.dataset.harness}｜${text(one('.ell', bar))}` : ''
  await until('侧栏里的会话', () => kit.titles('local').length >= 3)
  await kit.frame()
  const rows = all('.ss-row', kit.device('local')).map((row) =>
    [text(one('.title', row)), text(one('.chip', row)), one('.pill.wait', row) ? '等人' : ''].join(
      '｜',
    ),
  )
  bar?.click()
  await until('筛选取消', () => !one('.sb-filter-on'), 5000)
  return { line, rows }
}
