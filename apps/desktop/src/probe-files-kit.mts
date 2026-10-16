// 文件面板验收里几组脚本共用的那套手：点会话、找侧面板、找树上的行、看查看器、等。
// installFilesKit 被原样送进页面里执行一次，把这套手挂在 window 上；之后送进去的验收函数从 window 上取。
// 页面重新加载之后要再装一次。和别的验收一样，函数里不能引用函数外面的东西。

export interface RowSeen {
  /** 相对于根的路径 */
  path: string
  name: string
  kind: string
  expanded: boolean
  selected: boolean
  /** 在整棵（摊平了的）树里排第几行 */
  index: number
}

export interface FileTabSeen {
  path: string
  active: boolean
  preview: boolean
}

export interface Frames<T> {
  value: T
  /** 从开始做到做完（含做完之后多等的两帧）一共多久，毫秒 */
  ms: number
  /** 这段时间里每两帧之间隔了多久 */
  gaps: number[]
}

/** 核心报上来的：每个目录、每个文件各向设备问过几次；另外试读的那个路径读成了什么 */
export interface Checked {
  lists: Record<string, number>
  reads: Record<string, number>
  read?: { ok: boolean; kind?: string; code?: string; why?: string }
}

export interface FilesKit {
  sleep(ms: number): Promise<void>
  frame(): Promise<void>
  until<T>(what: string, check: () => T | null | undefined | false, ms?: number): Promise<T>
  /** 等一件事成立：等到了是 true，到点还没成立是 false，不报错 */
  seen(check: () => unknown, ms?: number): Promise<boolean>
  one<E extends Element = HTMLElement>(selector: string, root?: ParentNode | null): E | null
  all(selector: string, root?: ParentNode | null): HTMLElement[]
  text(element: Element | null | undefined): string
  /** 点侧栏里标题带这段字的会话，等它成了眼前的会话。验收里用哪个会话都明着去点，不靠“启动后选中了谁” */
  openSession(title: string): Promise<void>
  side(): HTMLElement | null
  sideOpen(): boolean
  /** 点标题栏上开合侧面板的按钮 */
  toggle(): void
  files(): HTMLElement | null
  root(): string
  /** 根下面的相对路径 → 完整路径 */
  full(relative: string): string
  tree(): HTMLElement | null
  rowCount(): number
  /** 现在画在页面上的那些行 */
  rows(): RowSeen[]
  row(relative: string): HTMLElement | null
  /** 等这一行画出来（它得在看得见的那一段里） */
  rowShown(relative: string, ms?: number): Promise<HTMLElement>
  /** 把树滚到第几行 */
  scrollTree(index: number): Promise<void>
  click(element: Element): void
  double(element: Element): void
  context(element: Element): void
  expand(relative: string, ms?: number): Promise<void>
  collapse(relative: string): Promise<void>
  /** 在树上点一个文件（pin：双击），等查看器里是它并且读完了。返回 .fv-file */
  open(relative: string, pin?: boolean, ms?: number): Promise<HTMLElement>
  /** 等查看器里是这个文件并且读完了 */
  viewed(relative: string, ms?: number): Promise<HTMLElement>
  tabs(): FileTabSeen[]
  code(): HTMLElement | null
  /** 等上色有了结果（上完了，或者定了不上），返回 data-paint */
  painted(ms?: number): Promise<string>
  /** 占位那一块是哪一种（没有占位是空的） */
  hold(): string
  /** 第几行是不是画出来了、并且在查看器看得见的范围里 */
  lineInView(line: number): boolean
  check(read?: string): Promise<Checked>
  write(target: HTMLTextAreaElement | HTMLInputElement, text: string): void
  press(target: Element, key: string, init?: KeyboardEventInit): void
  /** 在找文件的框里写字 */
  search(text: string): void
  hits(): { path: string; kind: string; marked: string }[]
  /** 在输入区里写一句话发出去 */
  say(text: string): Promise<void>
  /** 做一件事，同时量这段时间里的帧间隔 */
  frames<T>(run: () => Promise<T>): Promise<Frames<T>>
  toast(id: string): string
  /** 记一笔，只留在内存里：哪一步等不到的时候，连同当时页面的样子一起写进报错 */
  note(text: string): void
  /** 页面现在的样子，给报错用 */
  where(): string
}

export function installFilesKit(): boolean {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const store = window as unknown as { __filesLog?: string[] }
  store.__filesLog ??= []
  const log = store.__filesLog
  const note = (words: string) => {
    log.push(`${Math.round(performance.now())} ${words}`)
    if (log.length > 200) log.splice(0, log.length - 200)
  }
  // 等下一帧。帧一秒都不来的话不死等（窗口不显示、系统又在压后台进程的时候出过整页不出帧）：照样往下走并记一笔
  const frame = () =>
    new Promise<void>((done) => {
      let over = false
      const finish = (late: boolean) => {
        if (over) return
        over = true
        if (late) note('等了一秒没有出帧')
        done()
      }
      requestAnimationFrame(() => finish(false))
      setTimeout(() => finish(true), 1000)
    })
  const one = <E extends Element = HTMLElement>(
    selector: string,
    root: ParentNode | null = document,
  ): E | null => (root ?? document).querySelector<E>(selector)
  const all = (selector: string, root: ParentNode | null = document) => [
    ...(root ?? document).querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const side = () => one('.side')
  const sideOpen = () => {
    const panel = side()
    return panel !== null && !panel.hidden
  }
  const files = () => one('.files')
  const root = () => files()?.dataset.root ?? ''
  const full = (relative: string) => (relative ? `${root()}/${relative}` : root())
  const tree = () => one('.ft-scroll')
  const rowCount = () => Number(tree()?.dataset.rows ?? 0)
  const relativeOf = (path: string) => path.slice(root().length + 1)
  const where = (): string => {
    const panel = side()
    const body = one('.fv-file')
    return JSON.stringify({
      crumb: text(one('.crumb')),
      side: panel
        ? `${panel.hidden ? '收着' : '开着'} ${panel.offsetWidth}px ${panel.dataset.mode} ${panel.dataset.device}/${panel.dataset.workspace}`
        : '没有',
      root: root(),
      rows: tree() ? `${rowCount()} 行，画了 ${all('.ft-row, .ft-note').length} 行` : '没有树',
      treeHold: one('.ft-hold')?.dataset.hold ?? '',
      tabs: all('.fv-tab').map((tab) => relativeOf(tab.dataset.path ?? '')),
      file: body
        ? `${relativeOf(body.dataset.path ?? '')} ${body.dataset.state} ${body.dataset.kind} ${one('.fv-code')?.dataset.paint ?? ''} ${one('.fv-hold')?.dataset.hold ?? ''}`
        : '没开文件',
      turns: `${all('.turn').length} 个回合，最后一个里 ${all('a.file-link', all('.turn').at(-1)).length} 个文件链接${one('.running-line') ? '，还在跑' : ''}，输入框里是 ${JSON.stringify(one<HTMLTextAreaElement>('textarea.cmp-text')?.value ?? null)}，最后一条回答：${JSON.stringify((all('.md').at(-1)?.textContent ?? '').slice(0, 60))}`,
      focus: document.activeElement
        ? `${document.activeElement.tagName}.${document.activeElement.className}`
        : '',
      saved: localStorage.getItem('litch.side'),
      log: log.slice(-12),
    })
  }
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 20_000,
  ): Promise<T> => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    // 最后那一觉可能睡过了头：到点之后再看一眼
    const late = check()
    if (late) return late
    throw new Error(`等不到：${what}（当时：${where()}）`)
  }
  const seen = async (check: () => unknown, ms = 5000): Promise<boolean> => {
    const end = performance.now() + ms
    for (;;) {
      if (check()) return true
      if (performance.now() >= end) return false
      await sleep(16)
    }
  }
  const openSession = async (title: string) => {
    note(`点会话：${title}`)
    const row = await until(
      `侧栏里的“${title}”`,
      () => all('.ss-row').find((element) => element.textContent?.includes(title)),
      40_000,
    )
    row.click()
    await until(`“${title}”成了眼前的会话`, () => one('.crumb')?.textContent?.includes(title))
    await frame()
  }
  const toggle = () => one<HTMLButtonElement>('.tb-side')?.click()

  const seenRow = (element: HTMLElement): RowSeen => ({
    path: relativeOf(element.dataset.path ?? ''),
    name: text(element),
    kind: element.dataset.kind ?? '',
    expanded: element.getAttribute('aria-expanded') === 'true',
    selected: element.getAttribute('aria-selected') === 'true',
    index: Number(element.id.replace('ft-row-', '')),
  })
  const rows = () => all('.ft-row').map(seenRow)
  const row = (relative: string) => {
    const path = full(relative)
    return all('.ft-row').find((element) => element.dataset.path === path) ?? null
  }
  const rowShown = (relative: string, ms = 20_000) =>
    until(`树上的 ${relative}`, () => row(relative), ms)
  const scrollTree = async (index: number) => {
    const element = tree()
    if (!element) throw new Error('没有树')
    // 一行 24 像素（界面里的 ROW_HEIGHT）；滚到的位置对不对由调用的一方看行号
    element.scrollTop = index * 24
    await frame()
    await frame()
  }
  const mouse = (type: string, element: Element, detail: number, button = 0) => {
    const box = element.getBoundingClientRect()
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        detail,
        button,
        clientX: box.left + Math.min(box.width / 2, 40),
        clientY: box.top + box.height / 2,
      }),
    )
  }
  const click = (element: Element) => mouse('click', element, 1)
  const double = (element: Element) => {
    mouse('click', element, 1)
    mouse('click', element, 2)
    mouse('dblclick', element, 2)
  }
  const context = (element: Element) => mouse('contextmenu', element, 0, 2)
  const expand = async (relative: string, ms = 20_000) => {
    const element = await rowShown(relative)
    if (element.getAttribute('aria-expanded') !== 'true') click(element)
    await until(
      `${relative} 展开了`,
      () => row(relative)?.getAttribute('aria-expanded') === 'true',
      ms,
    )
  }
  const collapse = async (relative: string) => {
    const element = await rowShown(relative)
    if (element.getAttribute('aria-expanded') === 'true') click(element)
    await until(
      `${relative} 收起了`,
      () => row(relative)?.getAttribute('aria-expanded') === 'false',
    )
  }
  const viewed = (relative: string, ms = 20_000) =>
    until(
      `查看器里是 ${relative}`,
      () => {
        const body = one('.fv-file')
        return body?.dataset.path === full(relative) && body.dataset.state === 'ready' ? body : null
      },
      ms,
    )
  const open = async (relative: string, pin = false, ms = 20_000) => {
    const element = await rowShown(relative)
    if (pin) double(element)
    else click(element)
    return viewed(relative, ms)
  }
  const tabs = (): FileTabSeen[] =>
    all('.fv-tab').map((tab) => ({
      path: relativeOf(tab.dataset.path ?? ''),
      active: tab.dataset.active === 'true',
      preview: tab.dataset.preview === 'true',
    }))
  const code = () => one('.fv-code')
  const painted = async (ms = 30_000) => {
    const mode = await until(
      '上色有了结果',
      () => {
        const paint = code()?.dataset.paint
        return paint && paint !== 'pending' ? paint : null
      },
      ms,
    )
    await frame()
    return mode
  }
  const hold = () => one('.fv-hold')?.dataset.hold ?? ''
  const lineInView = (line: number) => {
    const view = code()
    const element = view ? one(`.cl[data-line="${line}"]`, view) : null
    if (!view || !element) return false
    const outer = view.getBoundingClientRect()
    const inner = element.getBoundingClientRect()
    return inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
  }
  const check = async (read?: string): Promise<Checked> => {
    const element = files()
    if (!element) throw new Error('没有文件面板')
    delete element.dataset.check
    element.dispatchEvent(new CustomEvent('litch:files-check', { detail: read ? { read } : {} }))
    const raw = await until('核心报上来问过几次', () => element.dataset.check)
    return JSON.parse(raw) as Checked
  }
  /** 往受控的输入框里写字：直接赋值界面不知道，要走原生的设值再发一个输入事件 */
  const write = (target: HTMLTextAreaElement | HTMLInputElement, value: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  }
  const search = (value: string) => {
    const input = one<HTMLInputElement>('.ft-search')
    if (!input) throw new Error('没有找文件的框')
    write(input, value)
  }
  const hits = () =>
    all('.ft-hit').map((hit) => ({
      path: relativeOf(hit.dataset.path ?? ''),
      kind: hit.dataset.kind ?? '',
      // 标出来的字按它们在路径里的先后拼：页面上名字画在目录前面
      marked: [...all('.ft-hit-dir mark', hit), ...all('.ft-hit-name mark', hit)]
        .map((mark) => mark.textContent ?? '')
        .join(''),
    }))
  const say = async (words: string) => {
    const input = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    write(input, words)
    await frame()
    press(input, 'Enter')
    await frame()
  }
  const frames = async <T,>(run: () => Promise<T>): Promise<Frames<T>> => {
    const gaps: number[] = []
    let on = true
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (on) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const started = performance.now()
    try {
      const value = await run()
      // 做完之后引出来的那一次重画也要量进去
      await frame()
      await frame()
      return { value, ms: performance.now() - started, gaps }
    } finally {
      on = false
    }
  }
  const toast = (id: string) => text(one(`[data-toast="${id}"] .toast-text`))

  const kit: FilesKit = {
    sleep,
    frame,
    until,
    seen,
    one,
    all,
    text,
    openSession,
    side,
    sideOpen,
    toggle,
    files,
    root,
    full,
    tree,
    rowCount,
    rows,
    row,
    rowShown,
    scrollTree,
    click,
    double,
    context,
    expand,
    collapse,
    open,
    viewed,
    tabs,
    code,
    painted,
    hold,
    lineInView,
    check,
    write,
    press,
    search,
    hits,
    say,
    frames,
    toast,
    note,
    where,
  }
  ;(window as unknown as { __filesKit: FilesKit }).__filesKit = kit
  return true
}
