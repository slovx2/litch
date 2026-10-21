// 侧栏验收：内置的“项目”组和拖着整理。对着模拟核心：本机有用户建的组“稍后看”，项目 litch、docs-site 在“项目”里。
// 拖放用页面里造的拖放事件（dragstart、dragover、drop），坐标按行的位置算：
// 停在工作区那一行的上半截是插到它前面、下半截是插到它后面，停在组的标题行上是放进这一组。
// 插入线在哪，按线的位置找它上面、下面紧挨着的是哪两行来认。量完把挪过的都挪回原样。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

export interface DragSeen {
  /** 本机下面各组的键，从上到下；“项目”那一行写的字、行尾的加号 */
  bands: string[]
  projectsLabel: string
  addLabel: string
  /** 点加号出的是“添加项目”对话框 */
  addDialog: string
  /** 一开始“项目”里的项目 */
  start: string[]
  /** 拖着 docs-site 停在 litch 上半截：提示是什么、线在哪两行之间、有没有标题行高亮 */
  beforeLitch: Hint
  /** 放下去之后“项目”里的顺序 */
  afterBefore: string[]
  /** 拖着 litch 停在 docs-site 下半截（就是原处）：不提示，放下去也不变 */
  sameSpot: Hint
  sameSpotOrder: string[]
  /** 拖着 litch 停在“稍后看”的标题上：标题行高亮、没有线；放下去之后它在哪一组 */
  intoSection: Hint
  litchBand: string
  /** litch 进了组之后，它菜单里“移到组”那一屏有没有“项目” */
  menuChoices: string
  /** 拖着 docs-site 停在组里 litch 的下半截：线在 litch 那一块（连同它下面的会话）和下一组的标题之间；放下去之后组里的顺序 */
  sectionEnd: Hint
  /** 这时 litch 那一块里最后一行写的是什么 */
  litchLast: string
  sectionOrder: string[]
  /** 这时“项目”空了：那一句提示 */
  projectsEmpty: string
  /** 拖着 docs-site 停在组里 litch 的上半截：线在组里的会话和 litch 之间 */
  sectionBefore: Hint
  sectionOrderAfter: string[]
  /** 拖着 litch 停在“项目”的标题上：标题行高亮；放下去之后回到“项目” */
  intoProjects: Hint
  backInProjects: string[]
  /** 拖着一个会话停在“稍后看”的标题上：是标题行高亮，不是线；松手不放，提示收掉 */
  sessionInto: Hint
  sessionCancelled: number
  /** 最后挪回原样：“项目”里的、“稍后看”里的项目 */
  end: string[]
  endSection: string[]
  /** 拖“项目”的标题行停在“稍后看”那一组的上半截：线在置顶的最后一行和“稍后看”之间 */
  bandLine: Hint
  /** 放下去之后本机下面各组的先后、这台电脑上记着的先后 */
  bandsMoved: string[]
  bandsSaved: string[]
  /** “项目”的“更多”里有什么；点“下移”之后各组的先后 */
  projectsMenu: string
  bandsBack: string[]
  /** 各套皮肤明暗下插入线的颜色和它底下的对比度 */
  lineContrast: number[]
}

/** 拖着东西停着时的提示：有什么记号；有线的话，线上面、下面紧挨着的那两行 */
export interface Hint {
  marks: string[]
  above: string
  below: string
}

export async function dragSeen(): Promise<DragSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, text, until, sleep, frame } = kit
  const local = () => kit.device('local')
  const SECTION = ':section:sec-later'
  const head = (group: string) => one<HTMLElement>(`[data-head="${group}"]`, local())
  const block = (id: string) => one<HTMLElement>(`[data-group="${id}"]`, local())
  const namesIn = (group: string) =>
    all(`[data-group="${group}"] [data-workspace] .name`, local()).map(text)
  const bandOf = (id: string) => block(id)?.closest<HTMLElement>('.band')?.dataset.group ?? ''

  // 页面里造的拖放：同一个 DataTransfer 从拿起带到放下，坐标落在 at 那一行高度的 part 处
  let carried: DataTransfer | null = null
  const fire = (type: string, at: Element, part = 0.5) => {
    const box = at.getBoundingClientRect()
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: carried,
      clientX: box.left + 30,
      clientY: box.top + box.height * part,
    })
    at.dispatchEvent(event)
  }
  const lift = async (line: Element) => {
    carried = new DataTransfer()
    line.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: carried }))
    await frame()
  }
  /** 拖到 at 那一行的 part 处停一下，读提示 */
  const hover = async (at: Element, part: number): Promise<Hint> => {
    fire('dragover', at, part)
    await sleep(60)
    fire('dragover', at, part)
    await frame()
    return hint()
  }
  const drop = async (at: Element, part: number) => {
    fire('drop', at, part)
    window.dispatchEvent(new DragEvent('dragend'))
    await sleep(150)
    await frame()
  }
  /** 一行写的是什么：标题行是名字，会话行是标题 */
  const labelOf = (line: Element) =>
    text(one('.name', line)) || text(one('.title', line)) || text(one('.sec-label', line))
  const hint = (): Hint => {
    const marks = all('[data-drop]', local()).map(
      (element) =>
        `${element.dataset.group ?? element.dataset.head ?? element.className.split(' ')[0]}:${element.dataset.drop}`,
    )
    const lined = one<HTMLElement>('.ws-block[data-drop], .band[data-drop]', local())
    if (!lined) return { marks, above: '', below: '' }
    const line = getComputedStyle(lined, '::before')
    const box = lined.getBoundingClientRect()
    const top =
      lined.dataset.drop === 'before'
        ? box.top + Number.parseFloat(line.top)
        : box.bottom - Number.parseFloat(line.bottom) - Number.parseFloat(line.height)
    const middle = top + Number.parseFloat(line.height) / 2
    const rows = all('.row-line, .band-empty', local()).filter((row) => row.offsetHeight > 0)
    const above = rows.filter((row) => row.getBoundingClientRect().bottom <= middle + 2).at(-1)
    const below = rows.find((row) => row.getBoundingClientRect().top >= middle - 2)
    return {
      marks,
      above: above ? labelOf(above) : '',
      below: below ? labelOf(below) : '',
    }
  }

  await until('侧栏里的项目', () => block('litch') && block('docs'), 10_000)
  const bands = all('[data-group]', local())
    .filter((group) => group.parentElement?.classList.contains('dev-body'))
    .map((group) => group.dataset.group ?? '')
  const projects = head(':projects')
  const projectsLabel = text(one('.sec-label', projects ?? undefined))
  const add = one<HTMLButtonElement>('.row-add', projects ?? undefined)
  const addLabel = add?.getAttribute('aria-label') ?? ''
  add?.click()
  const dialog = await until('添加项目的对话框', () => one('dialog.ws-dialog[open]'), 5000)
  const addDialog = dialog.getAttribute('aria-label') ?? ''
  one<HTMLButtonElement>('.modal-foot .btn', dialog)?.click()
  await until('对话框收起', () => !one('dialog.ws-dialog[open]'), 5000)
  const start = namesIn(':projects')

  // 一、在“项目”里调顺序：docs-site 插到 litch 前面
  await lift(head('docs') as HTMLElement)
  const beforeLitch = await hover(head('litch') as HTMLElement, 0.25)
  await drop(head('litch') as HTMLElement, 0.25)
  const afterBefore = namesIn(':projects')
  // 落下去还是原处的不提示：litch 停在 docs-site 的下半截
  await lift(head('litch') as HTMLElement)
  const sameSpot = await hover(head('docs') as HTMLElement, 0.75)
  await drop(head('docs') as HTMLElement, 0.75)
  const sameSpotOrder = namesIn(':projects')

  // 二、放进用户建的组：litch 拖到“稍后看”的标题上
  await lift(head('litch') as HTMLElement)
  const intoSection = await hover(head(SECTION) as HTMLElement, 0.5)
  await drop(head(SECTION) as HTMLElement, 0.5)
  const litchBand = bandOf('litch')
  ;(
    await until('litch 的“更多”', () =>
      one<HTMLButtonElement>('.row-more > .ibtn', head('litch') ?? undefined),
    )
  ).click()
  const pop = await until('litch 的菜单', () =>
    one('.row-more .pick-pop', head('litch') ?? undefined),
  )
  one<HTMLButtonElement>('.pick-opt[data-action="group"]', pop)?.click()
  await sleep(100)
  const menuChoices = all('.pick-opt', pop).map(text).join('|')
  kit.press(document.activeElement ?? pop, 'Escape')
  await kit.seen(() => !pop.isConnected, 3000)
  if (pop.isConnected) kit.press(document.activeElement ?? document.body, 'Escape')
  await sleep(100)

  // 三、插到组里：docs-site 停在组里 litch 的下半截（组的最后）
  await lift(head('docs') as HTMLElement)
  const sectionEnd = await hover(head('litch') as HTMLElement, 0.75)
  const litchRows = all('.row-line', block('litch') ?? undefined).filter(
    (row) => row.offsetHeight > 0,
  )
  const litchLast = litchRows.length > 0 ? labelOf(litchRows[litchRows.length - 1] as Element) : ''
  await drop(head('litch') as HTMLElement, 0.75)
  const sectionOrder = namesIn(SECTION)
  const projectsEmpty = text(one('[data-group=":projects"] .band-empty', local()))
  // 组里两个之间：docs-site 停在 litch 的上半截
  await lift(head('docs') as HTMLElement)
  const sectionBefore = await hover(head('litch') as HTMLElement, 0.25)
  await drop(head('litch') as HTMLElement, 0.25)
  const sectionOrderAfter = namesIn(SECTION)

  // 四、拖回“项目”：litch 拖到“项目”的标题上
  await lift(head('litch') as HTMLElement)
  const intoProjects = await hover(head(':projects') as HTMLElement, 0.5)
  await drop(head(':projects') as HTMLElement, 0.5)
  const backInProjects = namesIn(':projects')

  // 五、会话只有“放进”：拖着一个会话停在组的标题上，再松手不放
  const session = one<HTMLElement>('[data-group="docs"] .row-line[data-session]', local())
  await lift(session as HTMLElement)
  const sessionInto = await hover(head(SECTION) as HTMLElement, 0.5)
  window.dispatchEvent(new DragEvent('dragend'))
  await sleep(100)
  const sessionCancelled = all('[data-drop]', local()).length

  // 六、挪回原样：docs-site 回到“项目”、排在 litch 后面
  await lift(head('docs') as HTMLElement)
  await hover(head('litch') as HTMLElement, 0.75)
  await drop(head('litch') as HTMLElement, 0.75)
  const end = namesIn(':projects')
  const endSection = namesIn(SECTION)

  // 七、排组的先后：拖“项目”的标题行到“稍后看”前面，再用“项目”菜单里的“下移”挪回去
  const topBands = () =>
    all('[data-group]', local())
      .filter((group) => group.parentElement?.classList.contains('dev-body'))
      .map((group) => group.dataset.group ?? '')
  await lift(head(':projects') as HTMLElement)
  const bandLine = await hover(block(SECTION) as HTMLElement, 0.2)
  await drop(block(SECTION) as HTMLElement, 0.2)
  const bandsMoved = topBands()
  const bandsSaved =
    (
      JSON.parse(localStorage.getItem('litch.sidebar') ?? '{}') as {
        bands?: Record<string, string[]>
      }
    ).bands?.local ?? []
  ;(
    await until('“项目”的“更多”', () =>
      one<HTMLButtonElement>('.row-more > .ibtn', head(':projects') ?? undefined),
    )
  ).click()
  const projectsPop = await until('“项目”的菜单', () =>
    one('.row-more .pick-pop', head(':projects') ?? undefined),
  )
  const projectsMenu = all('.pick-opt', projectsPop).map(text).join('|')
  one<HTMLButtonElement>('.pick-opt[data-action="down"]', projectsPop)?.click()
  await sleep(150)
  await frame()
  const bandsBack = topBands()
  if (one('.row-more .pick-pop', local()))
    kit.press(document.activeElement ?? document.body, 'Escape')

  // 八、各套皮肤明暗下的插入线：线的颜色和它底下的对比度
  await lift(head('docs') as HTMLElement)
  await hover(head('litch') as HTMLElement, 0.25)
  const lineContrast = await kit.eachSkin(() => {
    const lined = one<HTMLElement>('.ws-block[data-drop]', local())
    if (!lined) return 0
    return kit.contrast(getComputedStyle(lined, '::before').backgroundColor, kit.backdrop(lined))
  })
  window.dispatchEvent(new DragEvent('dragend'))
  await sleep(100)

  return {
    bands,
    projectsLabel,
    addLabel,
    addDialog,
    start,
    beforeLitch,
    afterBefore,
    sameSpot,
    sameSpotOrder,
    intoSection,
    litchBand,
    menuChoices,
    sectionEnd,
    litchLast,
    sectionOrder,
    projectsEmpty,
    sectionBefore,
    sectionOrderAfter,
    intoProjects,
    backInProjects,
    sessionInto,
    sessionCancelled,
    end,
    endSection,
    bandLine,
    bandsMoved,
    bandsSaved,
    projectsMenu,
    bandsBack,
    lineContrast,
  }
}

/**
 * 截图用的场景，拖着不放：docs-site 停在 litch 上半截（line）或者“稍后看”的标题上（into），
 * 或者拖着“项目”的标题行停在“稍后看”那一组的上半截（band）
 */
export async function dragShown(kind: 'line' | 'into' | 'band'): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const local = kit.device('local')
  const head = (group: string) => kit.one<HTMLElement>(`[data-head="${group}"]`, local)
  window.dispatchEvent(new DragEvent('dragend'))
  const carried = new DataTransfer()
  head(kind === 'band' ? ':projects' : 'docs')?.dispatchEvent(
    new DragEvent('dragstart', { bubbles: true, dataTransfer: carried }),
  )
  await kit.frame()
  const at =
    kind === 'line'
      ? head('litch')
      : kind === 'band'
        ? kit.one<HTMLElement>('[data-group=":section:sec-later"]', local)
        : head(':section:sec-later')
  if (!at) throw new Error('侧栏里没有要停的那一行')
  const box = at.getBoundingClientRect()
  const over = () =>
    at.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: carried,
        clientX: box.left + 30,
        clientY: box.top + box.height * (kind === 'into' ? 0.5 : 0.2),
      }),
    )
  over()
  await kit.sleep(60)
  over()
  await kit.until('拖放的提示', () => kit.one('[data-drop]', local), 5000)
}

export function judgeDrag(seen: DragSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, message: string) => {
    if (!ok) failed.push(message)
  }
  const list = (names: string[]) => names.join('|')
  const SECTION = ':section:sec-later'
  /** 插入线：没有标题行高亮，线在 above 和 below 两行之间 */
  const line = (hint: Hint, above: string, below: string, what: string) =>
    must(
      hint.marks.length === 1 &&
        !hint.marks[0]?.endsWith(':into') &&
        hint.above === above &&
        hint.below === below,
      `${what}：应该是“${above}”和“${below}”之间一条线，实际 ${hint.marks.join(',') || '没有提示'}，线在“${hint.above}”和“${hint.below}”之间`,
    )
  /** 放进一组：只有那一行标题高亮（组是空的时候连同那一句提示），没有线 */
  const into = (hint: Hint, group: string, what: string) =>
    must(
      list(hint.marks.filter((mark) => mark !== 'band-empty:into')) === `${group}:into` &&
        hint.above === '' &&
        hint.below === '',
      `${what}：应该只有 ${group} 的标题行高亮，实际 ${hint.marks.join(',') || '没有提示'}`,
    )

  must(
    list(seen.bands) === `:pinned|${SECTION}|:projects|`,
    `本机下面的组不对（应该是置顶、用户的组、“项目”、无项目）：${seen.bands.join(' ')}`,
  )
  must(seen.projectsLabel === '项目', `“项目”那一行写的是：${seen.projectsLabel}`)
  must(seen.addLabel === '添加项目…', `“项目”行尾的加号不对：${seen.addLabel}`)
  must(seen.addDialog === '添加项目', `点加号出的不是添加项目的对话框：${seen.addDialog}`)
  must(list(seen.start) === 'litch|docs-site', `一开始“项目”里的不对：${list(seen.start)}`)

  line(seen.beforeLitch, '项目', 'litch', '拖着 docs-site 停在 litch 上半截')
  must(
    list(seen.afterBefore) === 'docs-site|litch',
    `docs-site 插到 litch 前面之后：${list(seen.afterBefore)}`,
  )
  must(
    seen.sameSpot.marks.length === 0 && list(seen.sameSpotOrder) === 'docs-site|litch',
    `落下去还是原处也提示了或者变了：${seen.sameSpot.marks.join(',')}，${list(seen.sameSpotOrder)}`,
  )

  into(seen.intoSection, SECTION, '拖着 litch 停在“稍后看”的标题上')
  must(seen.litchBand === SECTION, `litch 放进“稍后看”之后在：${seen.litchBand}`)
  must(
    seen.menuChoices.split('|')[0] === '项目',
    `组里的项目“移到组”那一屏第一项不是“项目”：${seen.menuChoices}`,
  )

  // 线在 litch 那一块的下沿：它下面的会话之后、下一组“项目”的标题之前（就是这一组的最后）
  must(seen.litchLast !== '' && seen.litchLast !== 'litch', `litch 下面没有会话：${seen.litchLast}`)
  line(seen.sectionEnd, seen.litchLast, '项目', '拖着 docs-site 停在组里 litch 的下半截')
  must(
    list(seen.sectionOrder) === 'litch|docs-site',
    `docs-site 插到组的最后之后：${list(seen.sectionOrder)}`,
  )
  must(seen.projectsEmpty.startsWith('还没有项目'), `“项目”空了的提示：${seen.projectsEmpty}`)
  // 组里先是会话、后是项目：litch 前面紧挨着的是组里那个会话
  line(
    seen.sectionBefore,
    '读一遍 launchd 的日志轮转',
    'litch',
    '拖着 docs-site 停在组里 litch 的上半截',
  )
  must(
    list(seen.sectionOrderAfter) === 'docs-site|litch',
    `docs-site 插到组里 litch 前面之后：${list(seen.sectionOrderAfter)}`,
  )

  into(seen.intoProjects, ':projects', '拖着 litch 停在“项目”的标题上')
  must(
    list(seen.backInProjects) === 'litch',
    `litch 拖回“项目”之后“项目”里的：${list(seen.backInProjects)}`,
  )

  into(seen.sessionInto, SECTION, '拖着会话停在“稍后看”的标题上')
  must(seen.sessionCancelled === 0, `松手不放之后提示还在：${seen.sessionCancelled} 处`)

  must(
    list(seen.end) === 'litch|docs-site' && seen.endSection.length === 0,
    `没挪回原样：项目 ${list(seen.end)}，稍后看 ${list(seen.endSection)}`,
  )
  // 组的先后：线在置顶的最后一行和“稍后看”的标题之间
  line(seen.bandLine, '文档站的待办汇总', '稍后看', '拖着“项目”的标题行停在“稍后看”上半截')
  must(
    list(seen.bandsMoved) === `:pinned|:projects|${SECTION}|`,
    `“项目”拖到“稍后看”前面之后各组：${seen.bandsMoved.join(' ')}`,
  )
  must(
    list(seen.bandsSaved) === `:projects|${SECTION}`,
    `组的先后没记在这台电脑上：${list(seen.bandsSaved)}`,
  )
  must(
    seen.projectsMenu === '添加项目…|下移',
    `“项目”的菜单不对（只该有添加项目和挪先后，不能改名、删除）：${seen.projectsMenu}`,
  )
  must(
    list(seen.bandsBack) === `:pinned|${SECTION}|:projects|`,
    `点“下移”之后各组：${seen.bandsBack.join(' ')}`,
  )
  must(
    seen.lineContrast.length === 6 && seen.lineContrast.every((ratio) => ratio >= 2),
    `插入线在有的皮肤下看不清（对比度）：${seen.lineContrast.map((ratio) => ratio.toFixed(2)).join(' ')}`,
  )
  return failed
}
