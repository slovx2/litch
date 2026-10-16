// 完整模式收尾的验收（真设备这一半）：对着隔离的多 harness 设备整理侧栏。
// 跟在 fullProbe 后面，在同一个窗口里接着量（见 smoke.mts）。夹具起来时一个项目都没有，从空开始建：
// 项目是设备级的，一个项目里混着两个 harness 的会话；置顶在 harness 掉线的时候也能做。
// “另一条连接改了，这边跟着变”在这里量不了（页面里起不了第二条连接），那一项在核心的单元测试和模拟核心那一半里。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface OrganizeProbe {
  /** 一开始：没有项目，会话都在“无项目”里；设备行上有“更多” */
  empty: boolean
  /** 添加：候选目录里有会话用过的目录；加成之后带着颜色，目录在它下面的会话归了进去，两个 harness 的都有 */
  candidates: boolean
  added: boolean
  mixed: boolean
  /** 目录不在它下面的会话还在“无项目” */
  looseKept: boolean
  /** 再加一个目录更深的：工作目录落在两个项目里的会话，归到更深的那个 */
  deepest: boolean
  /** 移到另一个项目：明说的归属压过按目录认的 */
  moved: boolean
  /** 置顶、取消置顶 */
  pinned: boolean
  unpinned: boolean
  /** 它的 harness 掉线的时候：菜单里只剩“置顶”，照样置得了；harness 回来之后还在置顶组里 */
  downMenu: boolean
  pinnedWhileDown: boolean
  pinKept: boolean
  /** 改名换色、调顺序 */
  edited: boolean
  reordered: boolean
  /** 删除只删记录：里面的会话都还在，按工作目录回到上一层的项目 */
  deleted: boolean
  /** 看到的原样。判不过的时候靠它知道差在哪 */
  seen: Record<string, string>
}

/** second：第二个 harness 的标识。让它掉线、恢复要打信号给起自检的脚本（和 fullProbe 一样） */
export async function organizeProbe(second: string): Promise<OrganizeProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const write = (target: HTMLInputElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const seen: Record<string, string> = {}
  const local = () => one('.dev-group') as HTMLElement
  const rowOf = (title: string) => all('.ss-row').find((row) => text(one('.title', row)) === title)
  const lineOf = (title: string) => rowOf(title)?.closest('.row-line')
  const groupOf = (title: string) =>
    rowOf(title)?.closest<HTMLElement>('[data-group]')?.dataset.group
  const groupKeys = () => all('[data-group]', local()).map((group) => group.dataset.group ?? '')
  const workspaceLine = (name: string) =>
    all('[data-workspace]', local()).find((line) => text(one('.name', line)) === name)
  const workspaceNames = () => all('[data-workspace] .name', local()).map(text)
  const keyOf = (name: string) => workspaceLine(name)?.dataset.workspace ?? '\0'
  const dotOf = (name: string) => one('.ws-dot', workspaceLine(name))?.getAttribute('style') ?? ''
  const menuOf = async (line: Element | null | undefined, what: string) => {
    if (!line) throw new Error(`侧栏里没有${what}`)
    ;(
      await until(`${what}的“更多”`, () => one<HTMLButtonElement>('.row-more > .ibtn', line))
    ).click()
    return until(`${what}的菜单`, () => one('.row-more .pick-pop', line))
  }
  const items = (pop: Element) => all('.pick-opt', pop).map(text).join('|')
  const choose = async (line: Element | null | undefined, what: string, action: string) => {
    const pop = await menuOf(line, what)
    const entry = one<HTMLButtonElement>(`.pick-opt[data-action="${action}"]`, pop)
    if (!entry) throw new Error(`${what}的菜单里没有 ${action}：${items(pop)}`)
    entry.click()
    await frame()
    return pop
  }
  const dialog = () => one<HTMLDialogElement>('dialog.ws-dialog[open]')
  const submit = () => one<HTMLButtonElement>('.ws-dialog .btn.primary')
  const color = (wire: string) =>
    one<HTMLButtonElement>(`.ws-colors button[aria-label="${wire}"]`)?.click()
  /** 打开“添加项目”，等目录那一栏出来 */
  const adding = async () => {
    await choose(one(':scope > .row-line', local()), '本机', 'addWorkspace')
    await until('添加项目的对话框', dialog)
    return until('目录那一栏', () => one<HTMLInputElement>('#ws-root'))
  }
  const name = async (words: string) =>
    write(await until('名字那一栏', () => one<HTMLInputElement>('#ws-name')), words)
  const send = async () => {
    await frame()
    submit()?.click()
    await until('对话框关掉', () => !dialog())
  }

  // 夹具里的会话：前两个是第一个 harness 的，后两个是第二个的；最后一个的目录不在 work/app 下
  const LIST = '给列表加上分页'
  const BUILD = '核对构建产物'
  const RELEASE = '整理发布说明'
  const TIMEOUT = '排查偶发的超时'
  const WEEKLY = '帮我想三个周报的小标题。'

  // ---- 一、从空开始 ----
  await until('会话都列出来', () => rowOf(LIST) && rowOf(TIMEOUT) && rowOf(WEEKLY))
  seen.before = `${groupKeys().join(' ')}｜${workspaceNames().join('|')}`
  const empty =
    workspaceNames().length === 0 &&
    groupOf(LIST) === '' &&
    Boolean(one(':scope > .row-line > .row-more', local()))

  // ---- 二、添加一个项目：目录从候选里挑 ----
  await adding()
  const roots = await until('候选的目录', () => {
    const found = all('.ws-dialog .ws-root').map(text)
    return found.length > 0 ? found : null
  })
  seen.candidates = roots.join('|')
  const app = roots.find((root) => root.endsWith('/work/app')) ?? ''
  const candidates = Boolean(app) && roots.some((root) => root.endsWith('/work/app/web'))
  all('.ws-dialog .ws-root')
    .find((entry) => text(entry) === app)
    ?.click()
  await until('候选填进了目录那一栏', () => one<HTMLInputElement>('#ws-root')?.value === app)
  await name('应用')
  color('blue')
  await send()
  await until('新的项目出现在侧栏里', () => workspaceLine('应用'))
  const appKey = keyOf('应用')
  await until('目录在它下面的会话归了进去', () => groupOf(LIST) === appKey)
  const inApp = [LIST, BUILD, RELEASE, TIMEOUT].map(groupOf)
  const badges = new Set(all(`[data-group="${appKey}"] .ss-row .chip`, local()).map(text))
  seen.badges = [...badges].join('|')
  const added = dotOf('应用').includes('blue') && inApp.every((group) => group === appKey)
  const mixed = badges.size >= 2
  const looseKept = groupOf(WEEKLY) === ''

  // ---- 三、再加一个目录更深的：落在两个项目里的会话归到更深的那个 ----
  write(await adding(), `${app}/web`)
  await name('网页')
  await send()
  await until('第二个项目', () => workspaceLine('网页'))
  const webKey = keyOf('网页')
  const deepest =
    Boolean(await until('它归到更深的那个项目', () => groupOf(BUILD) === webKey)) &&
    groupOf(LIST) === appKey

  // ---- 四、移到另一个项目 ----
  const movePop = await choose(lineOf(RELEASE), RELEASE, 'move')
  const targets = await until('可以移去的项目', () => {
    const found = all('.pick-choice', movePop)
    return found.length > 0 ? found : null
  })
  seen.moveChoices = targets.map(text).join('|')
  targets.find((entry) => text(entry) === '网页')?.click()
  // 它的工作目录是 work/app：按目录认该在“应用”里，明说的归属压过它
  const moved =
    seen.moveChoices === '网页' &&
    Boolean(await until('它换到了那个项目下面', () => groupOf(RELEASE) === webKey))

  // ---- 五、置顶、取消置顶；harness 掉线的时候也置得了 ----
  await choose(lineOf(TIMEOUT), TIMEOUT, 'pin')
  await until('它到了置顶组里', () => groupOf(TIMEOUT) === ':pinned')
  const pinned = groupKeys()[0] === ':pinned'
  await choose(lineOf(TIMEOUT), TIMEOUT, 'unpin')
  const unpinned = Boolean(await until('它回到项目里', () => groupOf(TIMEOUT) === appKey))
  const isDown = () => Boolean(rowOf(TIMEOUT)?.classList.contains('down'))
  console.log(`LITCH_SIGNAL stop ${second}`)
  await until('这一行显示成用不了', isDown)
  const downPop = await menuOf(lineOf(TIMEOUT), TIMEOUT)
  seen.downMenu = items(downPop)
  const downMenu = seen.downMenu === '置顶'
  one<HTMLButtonElement>('.pick-opt[data-action="pin"]', downPop)?.click()
  const pinnedWhileDown =
    Boolean(await until('掉线的时候置了顶', () => groupOf(TIMEOUT) === ':pinned')) && isDown()
  // 夹具要先看到那个运行时退出了，才肯把它重新起来
  await sleep(500)
  console.log(`LITCH_SIGNAL start ${second}`)
  await until('这一行恢复原样', () => !isDown(), 60_000)
  // 它回来之后会重新对一遍账：置顶是设备上记着的，还在
  await sleep(500)
  const pinKept = groupOf(TIMEOUT) === ':pinned'
  await choose(lineOf(TIMEOUT), TIMEOUT, 'unpin')
  await until('它回到项目里', () => groupOf(TIMEOUT) === appKey)

  // ---- 六、改名换色、调顺序 ----
  await choose(workspaceLine('应用'), '头一个项目', 'edit')
  await until('改名与颜色的对话框', dialog)
  await name('应用（改）')
  color('red')
  await send()
  await until('行上是新的名字', () => workspaceLine('应用（改）'))
  const edited =
    dotOf('应用（改）').includes('red') && keyOf('应用（改）') === appKey && !workspaceLine('应用')
  await choose(workspaceLine('网页'), '第二个项目', 'up')
  const reordered = Boolean(
    await until('它挪到了前面', () => workspaceNames().join('|') === '网页|应用（改）'),
  )

  // ---- 七、删除：只删记录，里面的会话按工作目录回到上一层的项目 ----
  const deletePop = await choose(workspaceLine('网页'), '第二个项目', 'delete')
  const asking = await until('删除之前的那一问', () => one('.pick-ask', deletePop))
  seen.deleteAsk = text(asking)
  one<HTMLButtonElement>('.btn.danger', asking)?.click()
  await until('项目没了', () => !workspaceLine('网页'))
  await until('里面的会话回到上一层的项目', () => groupOf(BUILD) === appKey)
  const deleted =
    seen.deleteAsk.includes('只删掉项目这条记录') &&
    groupOf(RELEASE) === appKey &&
    Boolean(rowOf(BUILD)) &&
    Boolean(rowOf(RELEASE))

  return {
    empty,
    candidates,
    added,
    mixed,
    looseKept,
    deepest,
    moved,
    pinned,
    unpinned,
    downMenu,
    pinnedWhileDown,
    pinKept,
    edited,
    reordered,
    deleted,
    seen,
  }
}

/** 哪些项不合格。全过就是空的 */
export function judgeOrganize(probe: OrganizeProbe): string[] {
  const { seen, ...checks } = probe
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => `整理侧栏（真设备）：${name} 不对`)
  if (failed.length > 0) failed.push(`看到的：${JSON.stringify(seen)}`)
  return failed
}
