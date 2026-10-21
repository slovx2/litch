// 后台任务的验收（对着模拟核心）：由 scripts/smoke.mjs --background 起（npm run check:background）。
// 模拟核心里说“后台任务”演一出（packages/core/src/mock/mock-background.mts）：回合说完时两条后台命令还在跑，
// 测试先跑完、harness 自己接着做（自发回合），dev 服务后来失败退出。这里照着看：
//   输入框上方一行只说有几个在跑、整条在呼吸，点开右侧“后台任务”页、再点收起；
//   右侧页运行中在上、已结束在下，每行名称、用时、状态，组头写跑完会不会接着做；
//   收起的过程那一行末尾“· 2 个在后台运行”；侧栏那一行是只剩后台任务在跑的记号，三种皮肤各画各的；
//   自发回合开头一行“后台任务结束，自动继续”和叫醒它的任务，没有用户气泡；
//   全部结束后提示行、收起行和侧栏上的记号都没了，右侧页只剩已结束的两行（完成、失败）。
// 下面的 backgroundProbe 会被原样送进页面里执行，不能引用函数外面的东西。

export interface BackgroundSeen {
  /** 输入框上方那一行：写着 2 个，在呼吸 */
  bar: boolean
  breathing: boolean
  /** 收起的过程那一行末尾写着 2 个在后台运行 */
  foldMark: boolean
  /** 侧栏那一行是后台任务的记号，不是转圈 */
  sidebarMark: boolean
  /** 三种皮肤各画各的：标准空心方块、复古 &、人文空心圆 */
  skinMarks: boolean
  /** 点那一行在右侧打开“后台任务”页：运行中两行，组头写跑完会接着做 */
  panelOpen: boolean
  panelRows: boolean
  wakesNote: boolean
  /** 再点一下收起 */
  panelClosed: boolean
  /** 自发回合开头一行写来历和叫醒它的任务，没有用户气泡 */
  originLine: boolean
  /** 一个跑完以后那一行写 1 个 */
  barOne: boolean
  /** 全部结束：提示行、收起行和侧栏的记号都没了 */
  barGone: boolean
  foldGone: boolean
  sidebarGone: boolean
  /** 右侧页只剩已结束的两行：完成一行、失败一行，写着没有在跑的 */
  panelEnded: boolean
  /** 三种皮肤、深浅两套下提示行、右侧页的行、开头那一行不溢出 */
  looks: string[]
  seen: Record<string, string>
}

export async function backgroundProbe(sessionId: string): Promise<BackgroundSeen> {
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
  const rowMark = () => $(`.row-line[data-session="${sessionId}"] .st`)

  await until(() => $(`.row-line[data-session="${sessionId}"]`) !== null, 20000)
  $(`.row-line[data-session="${sessionId}"] .ss-row`)?.click()
  await until(() => $('.main .dock textarea.cmp-text') !== null)
  await sleep(200)
  const box = $<HTMLTextAreaElement>('.main .dock textarea.cmp-text')
  if (!box) throw new Error('找不到输入框')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    box,
    '起两个后台任务',
  )
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(80)
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  // —— 回合说完、两条还在跑 ——
  const bar = await until(() => ($('.main .bgbar')?.dataset.background ?? '') === '2', 4000)
  seen.bar = $('.main .bgbar')?.textContent ?? '没有'
  const glow = $('.main .bgbar') ? getComputedStyle($('.main .bgbar') as HTMLElement) : null
  const breathing = (glow?.animationName ?? '').includes('bg-glow')
  const foldMark = ($('.main .proc-head .bgmark')?.dataset.background ?? '') === '2'
  seen.fold = $('.main .proc-head')?.textContent ?? '没有'
  const sidebarMark = rowMark()?.classList.contains('bg') === true
  seen.mark = rowMark()?.className ?? '没有'

  // 三种皮肤各画各的
  const root = document.documentElement
  const was = { skin: root.dataset.skin, theme: root.dataset.theme }
  const marks: string[] = []
  const looks: string[] = []
  for (const skin of ['standard', 'retro', 'human']) {
    for (const theme of ['light', 'dark']) {
      root.dataset.skin = skin
      root.dataset.theme = theme
      await sleep(80)
      const mark = rowMark()
      const before = mark ? getComputedStyle(mark, '::before') : null
      if (theme === 'dark')
        marks.push(`${skin}:${before?.content}:${before?.borderTopStyle}:${before?.borderRadius}`)
      for (const selector of ['.main .bgbar', '.main .proc-head']) {
        const element = $(selector)
        if (!element) continue
        if (element.scrollWidth > element.clientWidth + 1)
          looks.push(`${skin}/${theme}：${selector} 内容比框宽`)
        const style = getComputedStyle(element)
        if (style.color === style.backgroundColor)
          looks.push(`${skin}/${theme}：${selector} 字和底一个颜色`)
      }
    }
  }
  if (was.skin) root.dataset.skin = was.skin
  if (was.theme) root.dataset.theme = was.theme
  else delete root.dataset.theme
  seen.marks = marks.join(' | ')
  const skinMarks =
    marks.length === 3 &&
    /^standard:[^:]*:solid:0px$/.test(marks[0] ?? '') &&
    /^retro:"&":/.test(marks[1] ?? '') &&
    /^human:[^:]*:solid:50%$/.test(marks[2] ?? '')

  // —— 点开右侧的页，再收起，再打开 ——
  $('.main .bgbar')?.click()
  const panelOpen = await until(
    () => $('.bg-panel') !== null && $('.main .bgbar')?.getAttribute('aria-expanded') === 'true',
  )
  const panelRows = $$('.bg-panel .bg-row[data-status="running"]').length === 2
  const wakesNote = ($('.bg-group[data-group="running"] .bg-wakes')?.textContent ?? '') !== ''
  seen.panel = $('.bg-panel')?.innerText ?? '没有'
  $('.main .bgbar')?.click()
  const panelClosed = await until(
    () => $('.main .bgbar')?.getAttribute('aria-expanded') === 'false',
  )
  $('.main .bgbar')?.click()
  await until(() => $('.bg-panel') !== null)

  // —— 测试先跑完：自发回合 ——
  const originLine = await until(
    () => $('.main .turn-origin[data-origin="backgroundTask"]') !== null,
    10000,
  )
  const origin = $('.main .turn-origin[data-origin="backgroundTask"]')
  seen.origin = origin?.textContent ?? '没有'
  const originTurn = origin?.closest('.turn')
  const quiet =
    originTurn?.querySelector('.umsg') === null && (origin?.textContent ?? '').includes('npm test')
  for (const skin of ['standard', 'retro', 'human']) {
    for (const theme of ['light', 'dark']) {
      root.dataset.skin = skin
      root.dataset.theme = theme
      await sleep(60)
      for (const selector of ['.bg-panel .bg-row', '.main .turn-origin']) {
        for (const element of $$(selector)) {
          const box = element.getBoundingClientRect()
          if (box.width === 0 || box.height === 0)
            looks.push(`${skin}/${theme}：${selector} 看不见`)
          if (element.scrollWidth > element.clientWidth + 1)
            looks.push(`${skin}/${theme}：${selector} 内容比框宽`)
        }
      }
    }
  }
  if (was.skin) root.dataset.skin = was.skin
  if (was.theme) root.dataset.theme = was.theme
  else delete root.dataset.theme
  const barOne = await until(() => ($('.main .bgbar')?.dataset.background ?? '') === '1', 6000)

  // —— dev 服务也结束了 ——
  const barGone = await until(() => $('.main .bgbar') === null, 10000)
  await sleep(200)
  const foldGone = $('.main .proc-head .bgmark') === null
  const sidebarGone = rowMark()?.classList.contains('bg') === false
  const ended = $$('.bg-panel .bg-row').map((row) => row.dataset.status)
  seen.ended = ended.join(',')
  const panelEnded =
    $('.bg-panel .bg-empty') !== null &&
    ended.length === 2 &&
    ended.includes('completed') &&
    ended.includes('failed')

  return {
    bar,
    breathing,
    foldMark,
    sidebarMark,
    skinMarks,
    panelOpen,
    panelRows,
    wakesNote,
    panelClosed,
    originLine: originLine && quiet,
    barOne,
    barGone,
    foldGone,
    sidebarGone,
    panelEnded,
    looks,
    seen,
  }
}

const LABELS: Record<Exclude<keyof BackgroundSeen, 'seen' | 'looks'>, string> = {
  bar: '回合说完时输入框上方一行写着 2 个后台任务在跑',
  breathing: '那一行整条在呼吸',
  foldMark: '收起的过程那一行末尾写着 2 个在后台运行',
  sidebarMark: '侧栏那一行是后台任务的记号',
  skinMarks: '三种皮肤的侧栏记号：标准空心方块、复古 &、人文空心圆',
  panelOpen: '点那一行在右侧打开“后台任务”页',
  panelRows: '右侧页运行中两行',
  wakesNote: '运行中那一组的组头写跑完会不会接着做',
  panelClosed: '再点一下收起',
  originLine: '自发回合开头一行写来历和叫醒它的任务，没有用户气泡',
  barOne: '一个跑完以后那一行写 1 个',
  barGone: '全部结束后那一行没了',
  foldGone: '全部结束后收起行上的记号没了',
  sidebarGone: '全部结束后侧栏的记号没了',
  panelEnded: '右侧页只剩已结束的两行（完成、失败），写着没有在跑的',
}

export function judgeBackground(seen: BackgroundSeen): string[] {
  const failed: string[] = []
  for (const [key, label] of Object.entries(LABELS)) {
    if (seen[key as keyof typeof LABELS] !== true) failed.push(label)
  }
  failed.push(...new Set(seen.looks))
  return failed
}
