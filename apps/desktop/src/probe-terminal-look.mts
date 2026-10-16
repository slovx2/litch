// 终端验收的第三段，接在 mockFlow 后面：关标签的两种意思、退出与重开、六套皮肤下的配色和字体、中英文。
// 最后几个小函数是给“退出前清点”前后看一眼用的。量大小的两段在 probe-terminal-size.mts。
// 这里等的都是状态（kit.until、kit.seen），不是“睡一会儿再看”：慢机器上只是多等一会儿，不会错判。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface MockClose {
  /** 还在运行的终端点叉：先问，问的那一块里焦点在“留着”上 */
  asked: boolean
  askFocus: string
  choices: string[]
  /** 选“留着”：标签没了，出了“设备上的终端”的入口和一条能接回的提示 */
  leftGone: boolean
  stowedShown: string
  leftToast: boolean
  /** 从“设备上的终端”里接回：标签回来，里面的内容还在 */
  broughtBack: boolean
  contentKept: boolean
  /** 选“结束”：标签没了，也不在“设备上的终端”里 */
  endedGone: boolean
  /** exit 之后：标签留着，说明已退出和退出码，敲键没反应；重开之后是一个新的 shell */
  exitedNote: string
  deaf: boolean
  restartedFresh: boolean
  /** 已退出的点叉不用问，直接关 */
  closedDirectly: boolean
  /** 都关完之后是空的状态，有新开的按钮 */
  emptyShown: boolean
}

export async function mockClose(): Promise<MockClose> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text } = kit
  const closeButton = (index: number) => all('.term-tab .term-x > button')[index]

  await kit.pick(1)
  kit.run('echo keep-me')
  await kit.see('记号', /\nkeep-me/)
  closeButton(1)?.click()
  const pop = await until('问怎么关', () => one('.term-close'))
  const asked = true
  // 焦点是浮层画出来之后才放上去的
  await kit.seen(() => pop.contains(document.activeElement), 3000)
  const askFocus = (document.activeElement as HTMLElement | null)?.dataset.choice ?? ''
  const choices = all('[data-choice]', pop).map((entry) => entry.dataset.choice ?? '')
  one<HTMLButtonElement>('[data-choice="leave"]', pop)?.click()
  await until('标签收起了', () => kit.tabs().length === 1)
  const leftGone = kit.tabs().every((tab) => tab.name !== '终端 2')
  const stowedButton = await until('设备上的终端', () =>
    one<HTMLButtonElement>('.term-stowed > button'),
  )
  const stowedShown = text(stowedButton)
  // 提示是命令应答回来才出的，标签是列表的增量到了才没的：两样谁先到不一定
  const leftToast = await kit.seen(() => one('[data-toast^="terminal-left"]'), 3000)

  stowedButton.click()
  const row = await until('留在设备上的那一行', () => one('.term-stowed-row'))
  one<HTMLButtonElement>('[data-choice="attach"]', row)?.click()
  await until('标签回来了', () => kit.tabs().length === 2)
  await until('它上台了', () => kit.tabs()[1]?.active)
  const broughtBack = await kit.seen(() => !one('.term-stowed > button'), 3000)
  const contentKept = await kit.seen(() => kit.screen().includes('keep-me'), 3000)

  closeButton(1)?.click()
  const again = await until('再问一次', () => one('.term-close'))
  one<HTMLButtonElement>('[data-choice="end"]', again)?.click()
  await until('结束了', () => kit.tabs().length === 1)
  // 反面的事：过几帧再看它有没有冒出来
  for (let count = 0; count < 4; count++) await kit.frame()
  const endedGone = !one('.term-stowed > button')

  // 剩下的这一个：让它自己退出
  await kit.pick(0)
  kit.run('exit 3')
  const strip = await until('已退出的说明', () => one('.term-status[data-state="exited"]'))
  const exitedNote = text(strip)
  // 状态条占了终端底下两行的地方，终端这时候正在按新的高度重排：不能拿敲键前后的整屏去比
  const deaf = await kit.deaf()
  one<HTMLButtonElement>('[data-tool="restart"]', strip)?.click()
  await until('重开了', () => !one('.term-status') && kit.tabs()[0]?.state === 'running')
  await kit.see('新的欢迎语', 'Litch 的假终端')
  await kit.prompt()
  const restartedFresh = !kit.screen().includes('exit 3') && !kit.screen().includes('qzjxq')

  kit.run('exit')
  await until('又退出了', () => one('.term-status[data-state="exited"]'))
  closeButton(0)?.click()
  await until('直接关了', () => kit.tabs().length === 0)
  const closedDirectly = !one('.term-close')
  const empty = await until('空的状态', () => one('.term-empty'))
  const emptyShown = Boolean(one('[data-tool="new"]', empty))

  return {
    asked,
    askFocus,
    choices,
    leftGone,
    stowedShown,
    leftToast,
    broughtBack,
    contentKept,
    endedGone,
    exitedNote,
    deaf,
    restartedFresh,
    closedDirectly,
    emptyShown,
  }
}

export interface LookSeen {
  /** 每一套：皮肤/明暗｜终端的底色｜字的颜色｜皮肤变量里要的底色｜要的字色｜终端的字体｜皮肤要的等宽字体 */
  looks: string[]
  /** 英文界面下：标签的默认名字、清屏按钮上的字、面板的名字、新开按钮的名字 */
  english: string[]
  chinese: string[]
}

export async function lookSeen(): Promise<LookSeen> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { one, text } = kit
  // 换皮肤、明暗、语言走界面给验收留的口子，不靠界面上哪个按钮
  const look = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  /** 让浏览器把皮肤的变量算出来 */
  const wanted = () => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--mono)'
    const scope = one('.term-stage') ?? document.body
    scope.appendChild(probe)
    const style = getComputedStyle(probe)
    probe.style.color = 'var(--term-bg)'
    const back = style.color.replace(/\s/g, '')
    probe.style.color = 'var(--term-fg)'
    const fore = style.color.replace(/\s/g, '')
    const font = style.fontFamily.split(',')[0]?.trim() ?? ''
    probe.remove()
    return { back, fore, font }
  }
  const shown = () => {
    const back = one('.term-host.on .xterm-scrollable-element')
    const rows = one('.term-host.on .xterm-rows')
    return {
      back: (back ? getComputedStyle(back).backgroundColor : '').replace(/\s/g, ''),
      fore: (rows ? getComputedStyle(rows).color : '').replace(/\s/g, ''),
      font: (rows ? getComputedStyle(rows).fontFamily : '').split(',')[0]?.trim() ?? '',
    }
  }
  const before = look.get()
  const looks: string[] = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      // 皮肤和明暗分两次换、中间只隔一帧：换皮肤要等新字体，紧跟着再换明暗的时候前一次还没落地，
      // 后换的不能被先换的盖掉（出过这个毛病）
      look.set({ skin })
      await kit.frame()
      look.set({ theme })
      await kit.frame()
      const want = wanted()
      // 颜色当场换，字体要等字体文件到了才换：等到三样都对上（一直对不上就照实记下来）
      await kit.seen(() => {
        const now = shown()
        return now.back === want.back && now.fore === want.fore && now.font === want.font
      }, 10_000)
      const now = shown()
      looks.push(
        [`${skin}/${theme}`, now.back, now.fore, want.back, want.fore, now.font, want.font].join(
          '｜',
        ),
      )
    }
  }
  look.set({ skin: before.skin })
  await kit.frame()
  look.set({ theme: before.theme })
  await kit.frame()

  const words = () => [
    kit.tabs()[0]?.name ?? '',
    text(one('.term-tools [data-tool="clear"]')),
    kit.panel()?.getAttribute('aria-label') ?? '',
    one('.term-new')?.getAttribute('aria-label') ?? '',
  ]
  look.set({ lang: 'en' })
  await kit.seen(() => kit.panel()?.getAttribute('aria-label') === 'Terminal', 3000)
  const english = words()
  look.set({ lang: 'zh-CN' })
  await kit.seen(() => kit.panel()?.getAttribute('aria-label') === '终端', 3000)
  const chinese = words()
  return { looks, english, chinese }
}

/**
 * 现在有几个标签、各是什么状态。expect：应该剩几个，等到是这个数再读（一直不是也照实读）；
 * 不给的话是在看“没变”，过几帧再读
 */
export async function tabStates(expect?: number): Promise<string[]> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  if (expect === undefined) for (let count = 0; count < 6; count++) await kit.frame()
  else await kit.seen(() => kit.tabs().length === expect, 5000)
  return kit.tabs().map((tab) => `${tab.name}:${tab.state}`)
}

/** 再开出这么多个终端（退出前的清点要有东西可数） */
export async function openMore(count: number): Promise<number> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  for (let made = 0; made < count; made++) {
    const before = kit.tabs().length
    const button =
      kit.one<HTMLButtonElement>('.term-empty [data-tool="new"]') ??
      kit.one<HTMLButtonElement>('.term-new')
    button?.click()
    await kit.until('多了一个终端', () => kit.tabs().length === before + 1)
    await kit.prompt()
  }
  return kit.tabs().length
}
