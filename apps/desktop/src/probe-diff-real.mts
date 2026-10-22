// 差异面板的验收，对着真的 git：隔离的多 harness 设备（命令由设备进程起）和单个 harness 的入口（由那个引擎起）。
// 仓库是起验收的脚本（scripts/check-diff.mjs）在夹具的临时目录里现建的，暂存、还原只对它做。
// 这些函数被原样送进页面里执行，不能引用函数外面的东西。
import type { Asked, DiffKit } from './probe-diff-kit.mjs'
import type { FilesKit, Frames } from './probe-files-kit.mjs'

export interface RealSeen {
  /** 从点开标签到概况和内容都到，毫秒；这期间核心为它向设备起了几条命令 */
  openMs: number
  asked: Asked
  branch: string
  watching: boolean
  mode: string
  /** 树上的文件：记号 路径 +增 −删 */
  tree: string[]
  notes: Record<string, string>
  painted: number
  /** 改了的那个文件：画出来的加的行、删的行各几行；展开上下文之后多了几行 */
  rows: { add: number; del: number; before: number; after: number }
  scopes: Record<string, number>
  /** 暂存、取消暂存之后文件头上的按钮 */
  afterStage: string[]
  afterUnstage: string[]
  /** 还原：确认框上的话；取消之后还在；确认之后没了 */
  ask: string[]
  keptOnCancel: boolean
  goneOnYes: boolean
  askUntracked: string[]
  untrackedGone: boolean
  toasts: string[]
  /** 说了“改个文件”：回合结束之后面板自己换了一版，这两个文件在列表里 */
  turn: { moved: boolean; listed: string[]; refreshes: number; ms: number }
  /** 另一个会话的工作目录不是仓库：说什么 */
  plain: string
}

export async function realDiff(names: {
  session: string
  other: string
  appended: string
  created: string
}): Promise<RealSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, text } = kit
  await kit.openSession(names.session)
  const started = performance.now()
  await diff.open()
  const box = await diff.settled()
  const openMs = Math.round(performance.now() - started)
  const asked = await diff.asked()
  const branch = one('.db-total')?.getAttribute('title') ?? ''
  // 盯上了没有：对面的应答比概况晚一点到，等一等
  const watching = await kit.seen(
    () =>
      !(one('.db [data-tool="refresh"]')?.getAttribute('title') ?? '').includes(
        '不支持监视文件变化',
      ),
    5000,
  )
  const tree = await diff.listed()
  await until('上色到了', () => all('.dp [class^="hljs-"]').length > 0, 30_000)
  const painted = all('.dp [class^="hljs-"]').length
  const notes: Record<string, string> = {}
  for (const note of all('.dp-note')) notes[note.dataset.path ?? ''] = text(note)

  const file = 'src/app.ts'
  diff.treeRow(file)?.click()
  await until('app.ts 的行画出来', () => diff.rows(file).length > 0)
  const before = diff.rows(file).length
  // 合并着看时加删写在行上，并排着看时写在格子上
  const count = (name: string) =>
    diff.rows(file).filter((row) => row.classList.contains(name) || one(`.dc.${name}`, row)).length
  const add = count('add')
  const del = count('del')
  const more = await until('“展开”的按钮', () =>
    diff
      .rows(file)
      .map((item) => one<HTMLButtonElement>('button.dr-more', item))
      .find(Boolean),
  )
  more.click()
  await until('展开之后行多了', () => diff.rows(file).length > before, 30_000)
  const rows = { add, del, before, after: diff.rows(file).length }

  const scopes: Record<string, number> = { all: diff.count() }
  await diff.scope('staged')
  await diff.settled()
  scopes.staged = diff.count()
  await diff.scope('unstaged')
  await diff.settled()
  scopes.unstaged = diff.count()
  await diff.scope('all')
  await diff.settled()

  const toasts: string[] = []
  const noteToast = () => {
    const shown = kit.toast('diff-act')
    if (shown) toasts.push(shown)
  }
  // 树只画看得见的那一段：问“在不在列表里”要滚着收一遍路径，不能只看画着的那几行
  const listed = async (path: string) => (await diff.paths()).includes(path)
  const appeared = async (path: string, ms: number) => {
    const end = performance.now() + ms
    while (!(await listed(path))) {
      if (performance.now() > end) throw new Error(`等不到：列表里有 ${path}｜${diff.where()}`)
      await kit.frame()
    }
  }
  const dialog = () => one<HTMLDialogElement>('dialog.confirm')
  const askOf = () => {
    const element = dialog()
    return element ? [text(one('b', element)), text(one('.confirm-body > span', element))] : []
  }
  let seen = diff.version()
  diff.act(file, 'stage')
  await diff.settled(seen)
  const afterStage = diff.acts(file)
  seen = diff.version()
  diff.act(file, 'unstage')
  await diff.settled(seen)
  const afterUnstage = diff.acts(file)
  noteToast()
  diff.act(file, 'discard')
  await until('还原的确认框', dialog)
  const ask = askOf()
  one<HTMLButtonElement>('.btn.ghost', dialog())?.click()
  await until('确认框关了', () => !dialog())
  await kit.sleep(300)
  const keptOnCancel = await listed(file)
  seen = diff.version()
  diff.act(file, 'discard')
  await until('还原的确认框', dialog)
  one<HTMLButtonElement>('.confirm-yes', dialog())?.click()
  await diff.settled(seen)
  const goneOnYes = !(await listed(file))
  noteToast()
  const fresh = 'fresh.txt'
  diff.treeRow(fresh)?.click()
  await until('fresh.txt 的文件头', () => diff.head(fresh))
  diff.act(fresh, 'discard')
  await until('删除的确认框', dialog)
  const askUntracked = askOf()
  seen = diff.version()
  one<HTMLButtonElement>('.confirm-yes', dialog())?.click()
  await diff.settled(seen)
  const untrackedGone = !(await listed(fresh))
  noteToast()

  // 代理改文件：回合结束之后面板自己跟上
  const turns = all('.turn').length
  const base = await diff.asked()
  seen = diff.version()
  const said = performance.now()
  await kit.say('改个文件')
  await until('新的回合出来', () => all('.turn').length > turns, 30_000)
  await until('回合结束', () => !one('.running-line'), 120_000)
  await appeared(names.created, 30_000)
  await diff.settled(seen)
  const turnMs = Math.round(performance.now() - said)
  const afterTurn = await diff.paths()
  const turn = {
    moved: diff.version() !== seen,
    listed: [names.appended, names.created].filter((path) => afterTurn.includes(path)),
    refreshes: (await diff.asked()).refreshes - base.refreshes,
    ms: turnMs,
  }

  await kit.openSession(names.other)
  await diff.open()
  await until('不是仓库的目录有说法', () => one('.dz[data-why]'), 30_000)
  const plain = `${one('.dz')?.dataset.why ?? ''}：${text(one('.dz'))}`
  await kit.openSession(names.session)
  await diff.open()
  await diff.settled()
  return {
    openMs,
    asked,
    branch,
    watching,
    mode: box.dataset.mode ?? '',
    tree,
    notes,
    painted,
    rows,
    scopes,
    afterStage,
    afterUnstage,
    ask,
    keptOnCancel,
    goneOnYes,
    askUntracked,
    untrackedGone,
    toasts,
    turn,
    plain,
  }
}

export interface RealManySeen {
  /** 脚本往仓库里摆了几百个文件之后：从打信号到面板里看到它们，毫秒；是自己跟上的还是点了“重新取”才有 */
  arriveMs: number
  byWatch: boolean
  mode: string
  entries: number
  treeRows: number
  treeDrawn: number
  /** 这一版概况是起了几条命令取回来的 */
  spawns: number
  fold: Frames<number>
  scroll: Frames<number>
  step: Frames<string>
}

/** want：脚本会摆多少个文件。打一行 LITCH_SIGNAL diff-many，脚本看到之后去摆 */
export async function realMany(want: number): Promise<RealManySeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, frame } = kit
  const base = await diff.asked()
  const started = performance.now()
  console.log('LITCH_SIGNAL diff-many')
  // 根目录下多了一个目录，对面的监视会报：先等它自己跟上，等不到再点“重新取”
  const byWatch = await kit.seen(() => diff.count() >= want, 12_000)
  if (!byWatch) {
    for (let round = 0; round < 20 && diff.count() < want; round++) {
      diff.tool('refresh')
      await kit.seen(() => diff.count() >= want, 3000)
    }
  }
  const box = await until(
    '几百个文件到了',
    () => (diff.count() >= want ? diff.box() : null),
    20_000,
  )
  const arriveMs = Math.round(performance.now() - started)
  await until('内容取完', () => box.dataset.load === 'ready', 30_000)
  const spawns = (await diff.asked()).spawns - base.spawns
  const list = await until('变了的文件那一栏', () => one<HTMLElement>('.dt-list'))
  const total = () => Number(list.dataset.rows ?? 0)
  const treeRows = total()
  const treeDrawn = all('.dt-row').length
  const dir = await until('摆进去的那个目录', () =>
    all('.dt-row[data-kind="dir"]').find((row) => row.dataset.path === 'gen'),
  )
  const fold = await kit.frames(async () => {
    dir.click()
    await until('收起来了', () => total() < treeRows - want / 2)
    diff.treeRow('gen')?.click()
    await until('又展开了', () => total() === treeRows)
    return total()
  })
  const scroll = await kit.frames(async () => {
    const end = list.scrollHeight - list.clientHeight
    for (let at = 0; at <= 24; at++) {
      list.scrollTop = (end * at) / 24
      await frame()
    }
    return list.scrollTop
  })
  list.scrollTop = 0
  await frame()
  const step = await kit.frames(async () => {
    for (let n = 0; n < 6; n++) {
      const was = one('.dstep-at')?.textContent
      one<HTMLButtonElement>('[data-act="next"]')?.click()
      await until(
        '换到下一个文件',
        () => one('.dstep-at')?.textContent !== was && box.dataset.load === 'ready',
        30_000,
      )
    }
    return one('.dstep-at')?.textContent ?? ''
  })
  return {
    arriveMs,
    byWatch,
    mode: box.dataset.mode ?? '',
    entries: diff.count(),
    treeRows,
    treeDrawn,
    spawns,
    fold,
    scroll,
    step,
  }
}
