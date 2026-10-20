// 差异面板验收里几组脚本共用的那套手，架在文件面板验收的那一套（probe-files-kit.mts）上面：
// 打开差异标签、等概况和内容都到、看树上的文件、点文件头上的按钮、问核心为差异起过几条命令。
// installDiffKit 被原样送进页面里执行一次（要先装 installFilesKit），之后送进去的验收函数从 window 上取。
import type { FilesKit } from './probe-files-kit.mjs'

/** 核心报上来的：为差异向设备起过几条命令（各种各几条）、重新取过几次概况 */
export interface Asked {
  spawns: number
  refreshes: number
  byKind: Record<string, number>
}

export interface DiffKit {
  /** 差异标签的那个框。没开着是 null */
  box(): HTMLElement | null
  /** 打开侧面板、换到差异标签，等概况有了结果（不管是哪种结果） */
  open(): Promise<HTMLElement>
  version(): number
  /** 等概况换到了 after 之后的版本，而且内容也取完了 */
  settled(after?: number, ms?: number): Promise<HTMLElement>
  /** 概况里一共几个文件 */
  count(): number
  /** 树上现在画着的文件行：状态记号、路径、行上的字 */
  files(): { path: string; status: string; text: string }[]
  /**
   * 树上全部的文件行（树只画看得见的那一段，所以是从头滚到尾收一遍，收完滚回原处）：
   * 每个是“记号 路径 增删行数”
   */
  listed(): Promise<string[]>
  /** 树上全部文件的路径，收法同上。问“这个文件还在不在列表里”用它，不要只看画着的那几行 */
  paths(): Promise<string[]>
  treeRow(path: string): HTMLElement | null
  /** 内容区里这个文件的文件头 */
  head(path: string): HTMLElement | null
  /** 内容区里这个文件现在画着的行 */
  rows(path: string): HTMLElement[]
  /** 这个文件没有内容可画时的那句说明 */
  note(path: string): string
  /** 点文件头上的一个按钮（stage、unstage、discard） */
  act(path: string, act: string): void
  /** 文件头上现在有哪几个按钮 */
  acts(path: string): string[]
  scope(name: 'all' | 'staged' | 'unstaged'): Promise<void>
  /** 在筛文件的框里写字 */
  filter(text: string): Promise<void>
  /** 点顶上那一条里的一个按钮（layout、wrap、refresh） */
  tool(name: string): void
  pane(): HTMLElement | null
  /** 把侧面板的宽度调到 want 左右（用分隔条上的方向键，一下 24 像素；窗口放不下就到头为止）。返回调完之后的宽度 */
  resize(want: number): Promise<number>
  asked(): Promise<Asked>
  /** 页面现在的样子，给报错用 */
  where(): string
}

export function installDiffKit(): boolean {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { one, all, until, text, frame } = files
  const box = () => one('.diffs')
  const version = () => Number(box()?.dataset.version ?? 0)
  const count = () => Number(box()?.dataset.entries ?? 0)
  const pane = () => one('.dp')
  const where = () => {
    const element = box()
    if (!element) return `没有差异标签；侧面板${files.sideOpen() ? '开着' : '收着'}`
    const data = element.dataset
    return `差异：phase=${data.phase} source=${data.source} version=${data.version} entries=${data.entries} mode=${data.mode} load=${data.load}；说明=${text(one('.dz'))}；树上 ${all(
      '.dt-row[data-kind="file"]',
    )
      .map((row) => row.dataset.path)
      .join(' ')}`
  }
  /** 等一件事；等不到的时候把差异标签那一刻的样子也写进报错 */
  const wait = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms?: number,
  ): Promise<T> => {
    try {
      return await until(what, check, ms)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}｜${where()}`)
    }
  }
  const open = async () => {
    // 侧面板开没开按会话记：刚换了会话，面板要过一两帧才换成这个会话自己的开合，先等它定下来；
    // 开合按钮 150 毫秒里只认一次，没开成就隔一会儿再按
    await files.frame()
    await files.frame()
    for (let tries = 0; !files.sideOpen() && tries < 5; tries++) {
      files.toggle()
      await files.seen(() => files.sideOpen(), 600)
    }
    const tab = await until('差异标签', () => one<HTMLElement>('.side-tab[data-tab="diff"]'))
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return wait(
      '差异的概况有结果',
      () => {
        const element = box()
        return element && !['none', 'loading'].includes(element.dataset.phase ?? '')
          ? element
          : null
      },
      40_000,
    )
  }
  const settled = async (after = -1, ms = 40_000) => {
    const element = await wait(
      `差异换到新的一版并取完内容（之前是 ${after}）`,
      () => {
        const now = box()
        if (now?.dataset.phase !== 'ready' || Number(now.dataset.version) === after) {
          return null
        }
        // 一个文件都没有的时候没有内容要取
        return now.dataset.entries === '0' || now.dataset.load === 'ready' ? now : null
      },
      ms,
    )
    await frame()
    await frame()
    return element
  }
  const head = (path: string) => all('.dp-head').find((item) => item.dataset.path === path) ?? null
  /** 树只画看得见的那一段：从头滚到尾收一遍，收完滚回原处。路径 → “记号 路径 增删行数” */
  const scan = async () => {
    const seen = new Map<string, string>()
    const list = one('.dt-list')
    if (!list) return seen
    const was = list.scrollTop
    const collect = () => {
      for (const row of all('.dt-row[data-kind="file"]', list)) {
        const path = row.dataset.path ?? ''
        seen.set(path, `${text(one('.dmark', row))} ${path} ${text(one('.dcount', row))}`.trim())
      }
    }
    const step = Math.max(24, list.clientHeight / 2)
    for (let top = 0; top < list.scrollHeight; top += step) {
      list.scrollTop = top
      await frame()
      collect()
    }
    list.scrollTop = was
    await frame()
    return seen
  }
  const kit: DiffKit = {
    box,
    open,
    version,
    settled,
    count,
    files: () =>
      all('.dt-row[data-kind="file"]').map((row) => ({
        path: row.dataset.path ?? '',
        status: row.dataset.status ?? '',
        text: text(row),
      })),
    listed: async () => [...(await scan()).values()],
    paths: async () => [...(await scan()).keys()],
    treeRow: (path) => all('.dt-row').find((row) => row.dataset.path === path) ?? null,
    head,
    rows: (path) =>
      all('.dp-rows')
        .filter((item) => item.dataset.path === path)
        .flatMap((item) => all('.dr', item)),
    note: (path) => text(all('.dp-note').find((item) => item.dataset.path === path)),
    act(path, act) {
      const button = one<HTMLButtonElement>(`[data-act="${act}"]`, head(path))
      if (!button) throw new Error(`“${path}”的文件头上没有 ${act} 这个按钮（${where()}）`)
      button.click()
    },
    acts: (path) => all('[data-act]', head(path)).map((button) => button.dataset.act ?? ''),
    async scope(name) {
      const button = await until(`“${name}”这个范围`, () =>
        one<HTMLElement>(`.db-seg [data-scope="${name}"]`),
      )
      button.click()
      await wait(
        `换到“${name}”之后概况到了`,
        () => button.getAttribute('aria-checked') === 'true' && box()?.dataset.phase === 'ready',
      )
      await frame()
    },
    async filter(words) {
      const input = await until('筛文件的框', () => one<HTMLInputElement>('.dt-search'))
      files.write(input, words)
      await frame()
      await frame()
    },
    tool(name) {
      const button = one<HTMLButtonElement>(`.db [data-tool="${name}"]`)
      if (!button) throw new Error(`顶上没有 ${name} 这个按钮`)
      button.click()
    },
    pane,
    async resize(want) {
      const grip = await until('侧面板的分隔条', () => one<HTMLElement>('.side-grip'))
      const width = () => files.side()?.offsetWidth ?? 0
      for (let count = 0; count < 60 && Math.abs(width() - want) >= 24; count++) {
        const before = width()
        files.press(grip, width() < want ? 'ArrowLeft' : 'ArrowRight')
        await frame()
        await frame()
        if (width() === before) break
      }
      return width()
    },
    async asked() {
      const element = box()
      if (!element) throw new Error('没有差异标签')
      delete element.dataset.check
      element.dispatchEvent(new CustomEvent('litch:diff-check'))
      return JSON.parse(await until('核心报上来起过几条命令', () => element.dataset.check)) as Asked
    },
    where,
  }
  ;(window as unknown as { __diffKit: DiffKit }).__diffKit = kit
  return true
}
