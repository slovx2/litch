// 文件面板的验收，对着真的文件系统：隔离的设备夹具（聚合面，文件由设备进程读）和单个 harness 的入口。
// 夹具自己的临时目录里由 scripts/check-files.mjs 摆好了一批文件（三万个条目的目录、六千行的源文件、
// 超过上限的、不是文字的、几种符号链接、隐藏的），这里照着那份布置去量。编排在 probe-files-run.mts。
// 这一段量树：懒加载、每层只问一次、大目录、符号链接、找文件、根之外的路径被拒。
import type { FilesKit } from './probe-files-kit.mjs'

export interface RealTree {
  place: string
  root: string
  /** 根下面有什么，每项写成“种类:名字”（没开隐藏文件的时候） */
  rootRows: string[]
  hiddenShown: string[]
  rootAsked: number
  /** 三万个条目的目录：点下去到画出来多久、这段时间的帧间隔、行数、画了多少行、问过几次、头几行 */
  manyMs: number
  manyGaps: number[]
  manyRows: number
  manyDom: number
  manyAsked: number
  manyHead: string[]
  /** 在里面一路滚到底的帧间隔；三万个条目里的最后一项画的是谁；有几帧看得见的地方是空的 */
  rollGaps: number[]
  tail: string
  blank: number
  /** 收起再马上展开，还是只问过一次 */
  reexpandAsked: number
  /** 指向目录的符号链接里面有什么；指向根外面的那个里面有什么（设备会跟着链接走，这一头拦不住） */
  linkDir: string[]
  linkOut: string[]
  emptyNote: string
  /** 找文件：结果、标出来的字、多久出来（毫秒）；命中的文件所在的目录没有被列过 */
  hits: string[]
  marked: string
  searchMs: number
  hitParentAsked: number
  /** 回车打开找到的那个，回到树上它露出来了 */
  hitOpened: string
  hitRevealed: boolean
  /** 根之外的路径：用上一级目录绕出去的、直接给完整路径的，各被怎么拒的 */
  outsideDots: string
  outsideFull: string
  /** 经过指向根外面的符号链接去读：读成了什么（已知拦不住，记下来） */
  viaLink: string
}

export async function realTree(session: string, outside: string): Promise<RealTree> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame } = kit
  await until('侧栏里有会话', () => one('.ss-row'), 60_000)
  await kit.openSession(session)
  if (!kit.sideOpen()) {
    kit.toggle()
    await until('面板打开', () => kit.sideOpen())
  }
  await until('树取到了根', () => kit.rows().length > 0, 30_000)
  // 符号链接是补问了才知道是目录还是文件的：等它们都有了着落
  await kit.seen(() => kit.rows().find((row) => row.path === 'link-dir')?.kind === 'dir', 10_000)
  const panel = kit.side()
  const place = `${panel?.dataset.device}/${panel?.dataset.workspace}`
  const root = kit.root()
  const rootRows = kit.rows().map((row) => `${row.kind}:${row.name}`)
  const askedOf = (lists: Record<string, number>, relative: string) =>
    lists[relative ? `${root}/${relative}` : root] ?? 0
  const rootAsked = askedOf((await kit.check()).lists, '')

  const plain = new Set(kit.rows().map((row) => row.name))
  const hiddenButton = one<HTMLButtonElement>('[data-tool="hidden"]') as HTMLButtonElement
  hiddenButton.click()
  await until('隐藏的出来了', () => kit.rows().some((row) => row.name.startsWith('.')))
  const hiddenShown = kit
    .rows()
    .map((row) => row.name)
    .filter((name) => !plain.has(name))
  hiddenButton.click()
  await until('隐藏的又收了', () => !kit.rows().some((row) => row.name.startsWith('.')))

  // ---------- 符号链接、空目录 ----------
  const childrenOf = async (relative: string) => {
    await kit.expand(relative)
    await until(`${relative} 里面的东西`, () =>
      kit.rows().some((row) => row.path.startsWith(`${relative}/`)),
    )
    const names = kit
      .rows()
      .filter((row) => row.path.startsWith(`${relative}/`))
      .map((row) => `${row.kind}:${row.name}`)
    await kit.collapse(relative)
    return names
  }
  const linkDir = await childrenOf('link-dir')
  const linkOut = await childrenOf('link-out')
  kit.click(await kit.rowShown('empty'))
  const emptyNote = text(
    await until('空目录的说明', () =>
      all('.ft-note').find((note) => note.dataset.kind === 'empty'),
    ),
  )
  await kit.collapse('empty')

  // ---------- 三万个条目的目录 ----------
  const before = kit.rowCount()
  const grown = await kit.frames(async () => {
    const started = performance.now()
    kit.click(await kit.rowShown('many'))
    await until('三万行到了', () => kit.rowCount() - before >= 30_000, 90_000)
    await frame()
    return performance.now() - started
  })
  const manyIndex = kit.rows().find((row) => row.path === 'many')?.index ?? -1
  const manyHead = kit
    .rows()
    .filter((row) => row.index > manyIndex)
    .slice(0, 3)
    .map((row) => row.name)
  const manyDom = all('.ft-row, .ft-note').length
  const manyRows = kit.rowCount()
  const manyAsked = askedOf((await kit.check()).lists, 'many')
  const treeElement = kit.tree() as HTMLElement
  let blank = 0
  const rolled = await kit.frames(async () => {
    const bottom = treeElement.scrollHeight - treeElement.clientHeight
    const steps = 90
    for (let step = 1; step <= steps; step++) {
      treeElement.scrollTop = Math.round((bottom * step) / steps)
      await frame()
      const box = treeElement.getBoundingClientRect()
      const visible = all('.ft-row, .ft-note').some((row) => {
        const at = row.getBoundingClientRect()
        return at.bottom > box.top && at.top < box.bottom
      })
      if (!visible) blank++
    }
  })
  await until('滚到底了', () => Number(treeElement.dataset.last) === kit.rowCount())
  // many 里面的最后一项：它下面先是 30 个目录，再是三万个文件
  const tailIndex = manyIndex + 30 + 30_000
  await kit.scrollTree(tailIndex - 3)
  const tail =
    (await until('最后那一项', () => kit.rows().find((row) => row.index === tailIndex))).name ?? ''
  await kit.scrollTree(manyIndex)
  await kit.collapse('many')
  kit.click(await kit.rowShown('many'))
  await until('又是三万行', () => kit.rowCount() - before >= 30_000, 90_000)
  const reexpandAsked = askedOf((await kit.check()).lists, 'many')
  await kit.collapse('many')
  await kit.scrollTree(0)

  // ---------- 找文件 ----------
  const hitParentAsked = askedOf((await kit.check()).lists, 'lib/deep')
  const input = await until('找文件的框', () => one<HTMLInputElement>('.ft-search'))
  const searchStarted = performance.now()
  kit.search('needlefile')
  await until('结果出来了', () => one('.ft-hits')?.dataset.query === 'needlefile', 60_000)
  const searchMs = performance.now() - searchStarted
  const found = kit.hits()
  const hits = found.map((hit) => `${hit.kind}:${hit.path}`)
  const marked = found[0]?.marked ?? ''
  kit.press(input, 'Enter')
  const first = found[0]?.path ?? ''
  await kit.viewed(first, 30_000)
  const hitOpened = kit
    .tabs()
    .filter((tab) => tab.active)
    .map((tab) => `${tab.path}${tab.preview ? '~' : ''}`)
    .join('')
  kit.press(input, 'Escape')
  await until('回到树上', () => input.value === '' && kit.tree())
  const hitRevealed = await kit.seen(
    () => kit.row(first)?.getAttribute('aria-selected') === 'true',
    15_000,
  )

  // ---------- 根之外的路径 ----------
  const refused = async (path: string) => {
    const { read } = await kit.check(path)
    return read?.ok ? `读成了 ${read.kind}` : `${read?.code}：${read?.why}`
  }
  const outsideDots = await refused(`${root}/../../outside/secret.txt`)
  const outsideFull = await refused(`${outside}/secret.txt`)
  const viaLink = await refused(`${root}/link-out/secret.txt`)

  return {
    place,
    root,
    rootRows,
    hiddenShown,
    rootAsked,
    manyMs: grown.value,
    manyGaps: grown.gaps,
    manyRows,
    manyDom,
    manyAsked,
    manyHead,
    rollGaps: rolled.gaps,
    tail,
    blank,
    reexpandAsked,
    linkDir,
    linkOut,
    emptyNote,
    hits,
    marked,
    searchMs,
    hitParentAsked,
    hitOpened,
    hitRevealed,
    outsideDots,
    outsideFull,
    viaLink,
  }
}
