// 终端验收里几组脚本共用的那套手：找面板、读终端里显示的字、敲键、等。
// installTerminalKit 被原样送进页面里执行一次，把这套手挂在 window 上；之后送进去的验收函数从 window 上取。
// 页面重新加载之后（比如核心重启）要再装一次。和别的验收一样，函数里不能引用函数外面的东西。

export interface TabSeen {
  id: string
  name: string
  state: string
  active: boolean
}

export interface TerminalKit {
  sleep(ms: number): Promise<void>
  frame(): Promise<void>
  until<T>(what: string, check: () => T | null | undefined | false, ms?: number): Promise<T>
  /**
   * 等一件事成立：等到了是 true，到点还没成立是 false，不报错。量“有没有”“对不对”的地方用它代替“睡一会儿再看”，
   * 结果照样交给后面去判；慢机器上只是多等一会儿
   */
  seen(check: () => unknown, ms?: number): Promise<boolean>
  one<E extends Element = HTMLElement>(selector: string, root?: ParentNode): E | null
  all(selector: string, root?: ParentNode): HTMLElement[]
  text(element: Element | null | undefined): string
  panel(): HTMLElement | null
  panelOpen(): boolean
  /** 点标题栏上开合终端的按钮 */
  toggle(): void
  tabs(): TabSeen[]
  /** 台上那个终端现在显示的每一行（行尾的空白去掉） */
  rows(): string[]
  screen(): string
  /** 最后一个不空的行 */
  lastLine(): string
  /** 台上那个终端接键盘的元素 */
  input(): HTMLTextAreaElement | null
  /** 敲一个能打印的 ASCII 字符 */
  key(char: string): void
  type(text: string): void
  enter(): void
  /** Ctrl 加一个字母 */
  ctrl(letter: string): void
  /** 贴一段字进去（中文走这条路） */
  paste(text: string): void
  /** 敲一行命令并回车 */
  run(command: string): void
  /** 等屏幕上出现这段字 */
  see(what: string, pattern: string | RegExp, ms?: number): Promise<void>
  /** 等提示符回来：最后一行以 $ 或 % 结尾 */
  prompt(ms?: number): Promise<void>
  /**
   * 等终端的大小定下来：字体到了，行列数连着 400 毫秒没再变。刚起来的终端在这之前不要敲命令：
   * 界面量准了字宽会改一次大小（过 60 毫秒才发给对面），对面的 shell 收到“窗口变了”。
   * bash 要是在回车前后收到它，会把提示符在下一行重画一遍，命令的输出就接在重画的提示符后面，
   * 按“行首是什么”去找输出就找不到了（流水线上挂过；用伪终端单独复现过，12 次里 5 次）
   */
  calm(): Promise<void>
  /** 敲一个字符（不能是空格），量它显示出来花了多久（毫秒） */
  echo(char: string): Promise<number>
  /**
   * 敲了 clear 之后等屏幕清了：只剩提示符那一行。
   * 孤零零的一个 % 不算数：zsh 每次出提示符之前先打一个 % 再补空格补满一行，上一行要是没换行，这个记号就会留下来。
   * 窗口刚变窄、新的列数还没到它手里的时候，它按原来的列数补空格，折了行，记号也会留下（之后它收到新的列数，只重画提示符那一行）
   */
  cleared(): Promise<void>
  /** 等屏幕上的字不再变（连着几帧都一样），返回那时候的每一行 */
  steady(ms?: number): Promise<string[]>
  /**
   * 已经不在跑的终端敲键有没有反应：敲一串屏幕上本来没有的字，看它出不出现。没出现是 true。
   * 不拿敲键前后的整屏去比：状态条出来的时候终端正在按新的高度重排，整屏本来就在变
   */
  deaf(): Promise<boolean>
  /**
   * 问终端里的程序它现在几行（size 或 stty size），一直问到它说的行数和屏幕上画的行数对上，返回它最后说的那一行。
   * 面板的高度刚变的时候，终端重排、再告诉对面都要一点时间：等的是“对上了”，不是一段时间。到点还对不上就照实返回
   */
  rowsAgreed(command: string, ms?: number): Promise<string>
  /**
   * 屏幕上那一行“行数 列数”（size、stty size 的结果），没有就是 undefined。
   * 认的是行尾的两个数，前面可以有别的字：真的 shell 在回车之后、命令跑起来之前收到“窗口大小变了”，
   * 会在下一行把提示符和命令重画一遍，结果就接在重画的那一行后面（“$ stty size11 112”），不是自己占一行
   */
  sizeTold(): string | undefined
  /** 翻这么多页：负数往回翻（看更早的），正数往后翻 */
  turn(pages: number): void
  /** 点一个标签 */
  pick(index: number): Promise<void>
  /** 页面打一行信号，起验收的脚本看得到 */
  signal(text: string): void
  /** 记一笔，只留在内存里：哪一步等不到的时候，连同当时页面的样子一起写进报错 */
  note(text: string): void
  /** 页面现在的样子，给报错用 */
  where(): string
}

export function installTerminalKit(): boolean {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  // 等下一帧。帧一秒都不来的话不死等（窗口不显示，系统又在压后台进程的时候出过整页不出帧的情况）：
  // 照样往下走并记一笔，量帧间隔的地方会把这一秒如实量进去
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
    throw new Error(
      `等不到：${what}（屏幕：${JSON.stringify(rows().slice(-14))}；当时：${where()}）`,
    )
  }
  const seen = async (check: () => unknown, ms = 5000): Promise<boolean> => {
    const end = performance.now() + ms
    for (;;) {
      if (check()) return true
      if (performance.now() >= end) return false
      await sleep(16)
    }
  }
  // 排查用的记录只攒在内存里（页面重新加载就没了），等不到的时候才跟着报错出去：
  // 往外写会改变时序，把要找的竞态盖住
  const store = window as unknown as { __termLog?: string[] }
  store.__termLog ??= []
  const log = store.__termLog
  const note = (words: string) => {
    log.push(`${Math.round(performance.now())} ${words}`)
    if (log.length > 200) log.splice(0, log.length - 200)
  }
  const where = (): string => {
    const dock = panel()
    return JSON.stringify({
      dock: dock
        ? `${dock.hidden ? '收着' : '开着'} ${dock.offsetHeight}px ${dock.dataset.device}/${dock.dataset.group}`
        : '没有',
      toggle: one('.tb-term')?.getAttribute('aria-pressed') ?? '没有这个按钮',
      saved: localStorage.getItem('litch.terminal'),
      tabs: tabs().map((tab) => `${tab.name}:${tab.state}${tab.active ? '*' : ''}`),
      status: text(one('.term-status')),
      hosts: `${all('.term-host.on').length}/${all('.term-host').length}`,
      size: `${rows().length} 行`,
      crumb: text(one('.crumb')),
      session: text(one('.ss-row[aria-current="true"] .title')),
      sessions: all('.ss-row').length,
      page: document.visibilityState,
      toasts: all('[data-toast]').map((toast) => toast.dataset.toast ?? ''),
      log: log.slice(-40),
    })
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const panel = () => one('.term-dock')
  const panelOpen = () => {
    const dock = panel()
    return Boolean(dock && !dock.hidden && dock.offsetHeight > 0)
  }
  const rows = (): string[] =>
    all('.term-host.on .xterm-rows > div').map((row) =>
      // 终端控件拿不换行的空格占位，换回普通空格再比
      (row.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+$/, ''),
    )
  const screen = () => rows().join('\n')
  const lastLine = () => rows().findLast((row) => row.length > 0) ?? ''
  const input = () => one<HTMLTextAreaElement>('.term-host.on .xterm-helper-textarea')
  const fire = (type: string, init: KeyboardEventInit & { keyCode: number; charCode?: number }) => {
    const target = input()
    if (!target) throw new Error('台上没有终端')
    // 终端控件认的是老式的键码，标准的事件初始化里没有，得另外补上
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    for (const name of ['keyCode', 'which', 'charCode'] as const) {
      const value = name === 'charCode' ? (init.charCode ?? 0) : init.keyCode
      Object.defineProperty(event, name, { get: () => value })
    }
    target.dispatchEvent(event)
  }
  const key = (char: string) => {
    // 能打印的字符，终端控件在按下的那一下就收了：不用再补“按出字符”的那个事件，补了会多出一个
    // 键码只有字母数字照实给：别的符号的字符码会撞上功能键的键码（比如左花括号撞 F12），一律给个数字键的
    const upper = /[a-z0-9]/i.test(char) ? char.toUpperCase().charCodeAt(0) : 48
    // 大写字母是例外：终端控件把它们留给“按出字符”的那个事件，按下的那一下不收。不补的话大写字母就悄悄丢了
    const capital = /[A-Z]/.test(char)
    fire('keydown', { key: char, keyCode: upper, shiftKey: capital })
    if (capital) fire('keypress', { key: char, keyCode: upper, charCode: upper, shiftKey: true })
    fire('keyup', { key: char, keyCode: upper, shiftKey: capital })
  }
  const type = (words: string) => {
    for (const char of words) key(char)
  }
  const enter = () => {
    fire('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })
    fire('keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })
  }
  const ctrl = (letter: string) => {
    const keyCode = letter.toUpperCase().charCodeAt(0)
    fire('keydown', { key: letter, code: `Key${letter.toUpperCase()}`, keyCode, ctrlKey: true })
    fire('keyup', { key: letter, code: `Key${letter.toUpperCase()}`, keyCode, ctrlKey: true })
  }
  const paste = (words: string) => {
    const target = input()
    if (!target) throw new Error('台上没有终端')
    const data = new DataTransfer()
    data.setData('text/plain', words)
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }
  const run = (command: string) => {
    type(command)
    enter()
  }
  const see = async (what: string, pattern: string | RegExp, ms?: number) => {
    await until(
      what,
      () => (typeof pattern === 'string' ? screen().includes(pattern) : pattern.test(screen())),
      ms,
    )
  }
  const prompt = async (ms?: number) => {
    await until('提示符', () => /[$%#] ?$/.test(lastLine()), ms)
  }
  const calm = async () => {
    await document.fonts.ready
    const shape = () => `${rows().length}x${one('.term-host.on .xterm-screen')?.clientWidth ?? 0}`
    let last = shape()
    let since = performance.now()
    const end = since + 10_000
    while (performance.now() - since < 400 && performance.now() < end) {
      await sleep(16)
      const now = shape()
      if (now === last) continue
      last = now
      since = performance.now()
    }
  }
  const echo = async (char: string): Promise<number> => {
    const before = lastLine()
    const started = performance.now()
    key(char)
    // 一帧一帧地看：字是在画这一帧的时候出现的
    for (;;) {
      await frame()
      // 行尾的空白读的时候去掉了（提示符后面那个空格），所以只看是不是多出了这个字
      const now = lastLine()
      if (now.length > before.length && now.endsWith(char)) return performance.now() - started
      // 和别处等状态一样最多等 20 秒：回显慢不慢由划的线去说，这里只管“一直不出来”
      if (performance.now() - started > 20_000) throw new Error(`敲了 ${char} 没有回显`)
    }
  }
  const steady = async (ms = 5000): Promise<string[]> => {
    const end = performance.now() + ms
    let last = rows().join('\n')
    let calm = 0
    while (calm < 4 && performance.now() < end) {
      await frame()
      const now = rows().join('\n')
      calm = now === last ? calm + 1 : 0
      last = now
    }
    return rows()
  }
  const deaf = async (): Promise<boolean> => {
    const marker = 'qzjxq'
    type(marker)
    // 反面的事只能过一会儿再看。等久了不会把“没反应”错判成“有反应”，所以这一处按时间等在慢机器上也站得住
    for (let count = 0; count < 6; count++) await frame()
    await sleep(200)
    return !screen().includes(marker)
  }
  const cleared = async () => {
    await until('屏幕清了', () => {
      const left = rows().filter((row) => row.length > 0 && row !== '%')
      return left.length === 1 && /[$%#]$/.test(left[0] ?? '')
    })
  }
  const sizeTold = (): string | undefined => {
    for (const row of rows()) {
      const told = /(?:^|\D)(\d+ \d+)$/.exec(row)?.[1]
      if (told) return told
    }
    return undefined
  }
  const rowsAgreed = async (command: string, ms = 20_000): Promise<string> => {
    const end = performance.now() + ms
    for (let asked = 1; ; asked++) {
      run('clear')
      await cleared()
      run(command)
      const told = await until('行列数', sizeTold)
      await prompt()
      if (told.split(' ')[0] === String(rows().length) || performance.now() >= end) {
        note(`问了 ${asked} 遍行列数：${told}，屏幕上 ${rows().length} 行`)
        return told
      }
      await sleep(100)
    }
  }
  // 翻页用键盘（Shift+PageUp、Shift+PageDown）：终端控件的滚轮只认真的滚轮事件，页面里造的它不收
  const turn = (pages: number) => {
    const up = pages < 0
    for (let count = 0; count < Math.abs(pages); count++) {
      const init = {
        key: up ? 'PageUp' : 'PageDown',
        code: up ? 'PageUp' : 'PageDown',
        keyCode: up ? 33 : 34,
        shiftKey: true,
      }
      fire('keydown', init)
      fire('keyup', init)
    }
  }
  const tabs = (): TabSeen[] =>
    all('.term-tab').map((tab) => ({
      id: tab.dataset.terminal ?? '',
      name: text(one('.term-tab-btn', tab)),
      state: tab.dataset.state ?? '',
      active: tab.dataset.active === 'true',
    }))
  const kit: TerminalKit = {
    sleep,
    frame,
    until,
    seen,
    one,
    all,
    text,
    panel,
    panelOpen,
    toggle: () => {
      const button = one<HTMLButtonElement>('.tb-term')
      note(
        `点开合按钮（${button ? `按下之前 ${button.getAttribute('aria-pressed')}` : '没找到按钮'}）`,
      )
      button?.click()
    },
    tabs,
    rows,
    screen,
    lastLine,
    input,
    key,
    type,
    enter,
    ctrl,
    paste,
    run,
    see,
    prompt,
    calm,
    echo,
    steady,
    deaf,
    cleared,
    rowsAgreed,
    sizeTold,
    turn,
    async pick(index) {
      const tab = all('.term-tab-btn')[index]
      if (!tab) throw new Error(`没有第 ${index + 1} 个标签`)
      const id = tab.closest<HTMLElement>('.term-tab')?.dataset.terminal
      tab.click()
      await until(`第 ${index + 1} 个标签上台`, () => one('.term-host.on')?.dataset.terminal === id)
      await frame()
    },
    signal: (words) => console.log(`LITCH_SIGNAL ${words}`),
    note,
    where,
  }
  ;(window as unknown as { __termKit: TerminalKit }).__termKit = kit
  return true
}
