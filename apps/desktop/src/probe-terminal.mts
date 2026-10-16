// 终端面板的验收，对着模拟核心里的假 shell（packages/core/src/mock/mock-shell.mts）。
// 分几段送进页面里执行，中间夹着要主进程做的事（改窗口大小、退出前的清点），编排在 probe-terminal-run.mts。
// 页面里用的那套手在 probe-terminal-kit.mts；和别的验收一样，下面的函数不能引用函数外面的东西。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface MockBasics {
  /** 一开始面板是收着的；点标题栏的按钮打开，顺手开出第一个终端，焦点在终端里 */
  startsClosed: boolean
  opened: boolean
  firstTab: string
  focused: boolean
  welcome: boolean
  /** 敲一个键到它显示出来，每个键各花了多久（毫秒） */
  echoMs: number[]
  echoed: boolean
  /** 贴进去的中文和表情原样回显，命令的结果也对 */
  cjk: boolean
  /** 宽字符占两格：全角竖线和下面那行尺子上的同一列对齐，差多少像素 */
  wideOffset: number
  /** 链接画成了能点的 */
  linkShown: boolean
  /** 新开第二个，标签上的名字 */
  tabNames: string[]
  secondActive: boolean
  /** 慢慢出字：看到的步数是一点一点涨上去的（中间见过几种不同的步数） */
  slowSteps: number[]
  slowDone: boolean
  /** 切回第一个：内容还在 */
  firstKept: boolean
  /** 改名：双击改、回车生效；右边的按钮改、Esc 不生效 */
  renamed: string
  renameCancelled: boolean
  /** 清屏之后屏幕上只剩提示符，还能接着用 */
  cleared: boolean
  usableAfterClear: boolean
}

export async function mockBasics(): Promise<MockBasics> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text, frame, sleep } = kit
  await until('侧栏里有会话', () => one('.ss-row'))
  // 启动落在新建对话页。终端跟着眼前的会话走：先点开第一个工作区里排最前面的那个会话，
  // 这一段和后面几段量的都是它所在工作区的那一组
  const first = one('.ws-row')?.closest('[data-group]')?.querySelector<HTMLElement>('.ss-row')
  first?.click()
  await until('选中了第一个工作区里的会话', () => first?.getAttribute('aria-current') === 'true')
  const startsClosed = !kit.panelOpen()
  kit.toggle()
  await until('面板打开', () => kit.panelOpen())
  await until('顺手开出一个终端', () => kit.tabs().length === 1)
  await kit.see('欢迎语', 'Litch 的假终端')
  await kit.prompt()
  const firstTab = kit.tabs()[0]?.name ?? ''
  // 焦点是终端画出来之后才放进去的（要等字体）
  const focused = await kit.seen(() => document.activeElement === kit.input())
  const welcome = /\$$/.test(kit.lastLine())

  const echoMs: number[] = []
  for (const char of 'echo hello') {
    if (char === ' ') kit.key(char)
    else echoMs.push(await kit.echo(char))
  }
  kit.enter()
  await kit.see('echo 的结果', /\nhello\n/)
  await kit.prompt()
  const echoed = kit.rows().includes('hello')

  kit.type('echo ')
  kit.paste('你好，终端🙂')
  await until('贴进去的字回显', () => kit.lastLine().endsWith('echo 你好，终端🙂'))
  kit.enter()
  await until('中文的结果', () => kit.rows().includes('你好，终端🙂'))
  await kit.prompt()
  const cjk = kit.rows().includes('你好，终端🙂')

  // 宽字符：第一行里全角竖线前面是 5 个汉字，占 10 格；尺子那一行的第 11 个字符也在第 10 格
  kit.run('wide')
  await kit.see('尺子', '1234567890123456789')
  await kit.prompt()
  const leftOf = (rowText: string, needle: string, from = 0): number => {
    const row = all('.term-host.on .xterm-rows > div').find((entry) =>
      (entry.textContent ?? '').includes(rowText),
    )
    if (!row) return Number.NaN
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let seen = 0
    const target = (row.textContent ?? '').indexOf(needle, from)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (target < seen + length) {
        const range = document.createRange()
        range.setStart(node, target - seen)
        range.setEnd(node, target - seen + 1)
        return range.getBoundingClientRect().left
      }
      seen += length
    }
    return Number.NaN
  }
  const wideOffset = Math.abs(leftOf('中文宽字符', '｜') - leftOf('1234567890123456789', '1', 10))

  kit.run('link')
  await kit.see('网址', 'https://example.com/litch/terminal')
  await kit.prompt()
  // 链接要鼠标挪上去才画下划线：挪到它上面看一眼
  const linkRow = all('.term-host.on .xterm-rows > div').find((row) =>
    (row.textContent ?? '').includes('https://example.com'),
  )
  let linkShown = false
  if (linkRow) {
    const box = linkRow.getBoundingClientRect()
    const screen = one('.term-host.on .xterm-screen')
    const at = { clientX: box.right - 40, clientY: box.top + box.height / 2, bubbles: true }
    // 文字的宽度不到行尾：从行里的字算位置
    const walker = document.createTreeWalker(linkRow, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = (node.textContent ?? '').indexOf('example.com')
      if (offset < 0) continue
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      at.clientX = range.getBoundingClientRect().left + 2
    }
    screen?.dispatchEvent(new MouseEvent('mousemove', at))
    await until(
      '链接画出来',
      () => {
        screen?.dispatchEvent(new MouseEvent('mousemove', at))
        return one(
          '.term-host.on .xterm-rows .xterm-underline-1, .term-host.on .xterm-cursor-pointer',
        )
      },
      4000,
    ).then(
      () => {
        linkShown = true
      },
      () => {},
    )
    screen?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
  }

  // 新开第二个
  one<HTMLButtonElement>('.term-new')?.click()
  await until('第二个标签', () => kit.tabs().length === 2)
  await until('第二个上台', () => kit.tabs()[1]?.active)
  await kit.see('第二个的欢迎语', 'Litch 的假终端')
  await kit.prompt()
  const tabNames = kit.tabs().map((tab) => tab.name)
  const secondActive = kit.tabs()[1]?.active === true && !kit.screen().includes('你好，终端')

  // 慢慢出字：隔一会儿数一次屏幕上有几步
  kit.run('slow')
  const slowSteps: number[] = []
  const slowEnd = performance.now() + 20_000
  let slowDone = false
  while (performance.now() < slowEnd && !slowDone) {
    const steps = kit.screen().match(/第 \d+ 步，共 12 步/g)?.length ?? 0
    if (slowSteps.at(-1) !== steps) slowSteps.push(steps)
    slowDone = kit.screen().includes('做完了。')
    await sleep(40)
  }
  await kit.prompt()

  await kit.pick(0)
  const firstKept = kit.screen().includes('你好，终端🙂') && kit.screen().includes('hello')

  // 改名：双击标签
  const tabButton = () => all('.term-tab-btn')[0]
  tabButton()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const field = await until('改名的输入框', () => one<HTMLInputElement>('.term-rename'))
  const setValue = (target: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setValue(field, '构建')
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until('名字改了', () => kit.tabs()[0]?.name === '构建')
  const renamed = kit.tabs()[0]?.name ?? ''
  // 右边的按钮也能改；按 Esc 不算
  one<HTMLButtonElement>('.term-tools [data-tool="rename"]')?.click()
  const again = await until('又出了输入框', () => one<HTMLInputElement>('.term-rename'))
  setValue(again, '不要这个名字')
  again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until('输入框收起', () => !one('.term-rename'))
  await frame()
  const renameCancelled = kit.tabs()[0]?.name === '构建'

  // 清屏
  one<HTMLButtonElement>('.term-tools [data-tool="clear"]')?.click()
  await until('屏幕清了', () => !kit.screen().includes('hello'))
  const cleared =
    kit.rows().filter((row) => row.length > 0).length === 1 && /\$$/.test(kit.lastLine())
  kit.run('echo still-here')
  await kit.see('清屏之后还能用', /\nstill-here/)
  await kit.prompt()
  const usableAfterClear = kit.rows().includes('still-here')
  void text

  return {
    startsClosed,
    opened: kit.panelOpen(),
    firstTab,
    focused,
    welcome,
    echoMs,
    echoed,
    cjk,
    wideOffset,
    linkShown,
    tabNames,
    secondActive,
    slowSteps,
    slowDone,
    firstKept,
    renamed,
    renameCancelled,
    cleared,
    usableAfterClear,
  }
}
