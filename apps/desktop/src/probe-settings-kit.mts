// 设置页验收里页面这一头的工具：等、找、换外观、开关设置页，再加一个通用的量法——
// “这一屏有没有横向溢出、有没有读不清的字”（audit）。别的验收要量一屏在各套皮肤下的样子，也可以装上它来用。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西；装一次，后面几段脚本从 window 上取。

/** 一屏量出来的结果 */
export interface Audit {
  /** 横向溢出的地方：是哪个元素、多出来多少像素。没有就是空的 */
  overflow: string[]
  /** 读不清的字（对比度不到硬线的）：是哪个元素、头几个字、对比度 */
  unreadable: string[]
  /** 量了多少处字，其中对比度不到 4.5（小字的标准线）的有多少处。后一个只报数，不拦 */
  texts: number
  below45: number
  /** 最低的那一处：对比度和它是谁 */
  lowest: number
  lowestAt: string
  /** 有意淡下去、没有量的有多少处（禁用的控件、整块降了透明度的） */
  faded: number
}

export interface Look {
  skin: string
  theme: string
  density: string
  zoom: number
  lang: string
}

export interface SettingsKit {
  sleep(ms: number): Promise<void>
  frame(): Promise<void>
  until<T>(what: string, check: () => T | null | undefined | false, ms?: number): Promise<T>
  /** 在这段时间里等到了没有。等不到不报错，照实给 false */
  seen(check: () => unknown, ms: number): Promise<boolean>
  one<E extends Element = HTMLElement>(selector: string, root?: ParentNode): E | null
  all(selector: string, root?: ParentNode): HTMLElement[]
  text(element: Element | null | undefined): string
  /** 界面给验收留的换外观的口子 */
  look: { get(): Look; set(patch: Partial<Look>): void }
  /** 换了皮肤、明暗之后等它落定：字体到齐、再过两帧 */
  settled(): Promise<void>
  /** 按标题点开侧栏里的一个会话，等它的内容出来 */
  openSession(title: string): Promise<void>
  /** 从侧栏底部的入口打开设置页，并到这一组。已经开着就只换组 */
  openSettings(section?: string): Promise<HTMLElement>
  /** 设置页现在开着没有、在哪一组 */
  settingsAt(): string | null
  /** 量 scope 这一屏（一个选择器，量它里面的全部） */
  audit(scope: string): Audit
  /** 现在页面什么样：跑不完的时候报出去 */
  where(): string
}

export function installSettingsKit(): boolean {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const where = () =>
    [
      `设置页在${one('.set-page') ? `“${one('.set-content')?.dataset.section}”` : '没开'}`,
      `选中的会话“${text(one('.ss-row.sel .title'))}”`,
      `外观 ${JSON.stringify(look.get())}`,
      `页面 ${window.innerWidth}×${window.innerHeight}，像素比 ${window.devicePixelRatio}`,
    ].join('；')
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 15_000,
  ): Promise<T> => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    // 到点再看一眼：机器很忙时一次 sleep 就能睡过头，最后那一下等到了却没来得及看
    const last = check()
    if (last) return last
    throw new Error(`设置页的验收：等不到${what}（${where()}）`)
  }
  const seen = async (check: () => unknown, ms: number) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      if (check()) return true
      await sleep(16)
    }
    return Boolean(check())
  }
  const look = (window as unknown as { __litchLook: SettingsKit['look'] }).__litchLook
  if (!look) throw new Error('界面上没有给验收换外观的口子（window.__litchLook）')

  const settled = async () => {
    // 字体文件是用到才取的：换了皮肤，等新的字体到了再量，不然量到的是后备字体的宽度
    await Promise.race([document.fonts.ready, sleep(5000)])
    await frame()
    await frame()
  }
  const openSession = async (title: string) => {
    const row = await until(`侧栏里的会话“${title}”`, () =>
      all('.ss-row').find((entry) => entry.textContent?.includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => row.classList.contains('sel') && one('.tr .turn'))
  }
  const settingsAt = () => (one('.set-page') ? (one('.set-content')?.dataset.section ?? '') : null)
  const openSettings = async (section?: string) => {
    if (!one('.set-page')) {
      const entry = await until('侧栏底部的“设置”', () => one<HTMLElement>('.sb-link.settings'))
      entry.click()
    }
    const page = await until('设置页', () => one<HTMLElement>('.set-page'))
    if (section && settingsAt() !== section) {
      one(`.set-nav [data-section="${section}"]`)?.click()
      await until(`设置页的“${section}”那一组`, () => settingsAt() === section)
    }
    return page
  }

  // ---------- 量一屏：横向溢出、读不清的字 ----------

  /** 本来就该自己横着滚、或者自己管内容怎么画的东西：代码、表格、终端、许可的全文 */
  const SCROLLS_BY_DESIGN = 'pre, .code, .md table, .xterm, .lic-text, textarea'
  /** 读不清的硬线。4.5 是小字的标准线，三级墨色在浅色下本来就到不了，所以只报数 */
  const HARD_LINE = 3
  const label = (element: Element) =>
    `${element.tagName.toLowerCase()}${[...element.classList]
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join('')}`
  const shown = (element: Element) => {
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  /** 浏览器算出来的颜色：rgb(…)、rgba(…)，用了混色的是 color(srgb …)（那种写法的分量是 0 到 1） */
  const parse = (color: string): [number, number, number, number] => {
    const numbers = (color.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number)
    const unit = color.startsWith('color(') ? 255 : 1
    const [r = 0, g = 0, b = 0, a = 1] = numbers
    return [r * unit, g * unit, b * unit, color === 'transparent' ? 0 : a]
  }
  /** 半透明的一层盖在不透明的底上是什么颜色 */
  const over = (top: number[], bottom: number[]): [number, number, number] => {
    const [r = 0, g = 0, b = 0, a = 1] = top
    const [br = 0, bg = 0, bb = 0] = bottom
    return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
  }
  const luminance = (color: number[]) => {
    const [r = 0, g = 0, b = 0] = color.slice(0, 3).map((part) => {
      const channel = part / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: number[], b: number[]) => {
    const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }

  const audit = (scope: string): Audit => {
    const root = one(scope)
    if (!root) throw new Error(`设置页的验收：要量的这一屏不在（${scope}）`)
    const styles = new Map<Element, CSSStyleDeclaration>()
    const styleOf = (element: Element) => {
      let style = styles.get(element)
      if (!style) {
        style = getComputedStyle(element)
        styles.set(element, style)
      }
      return style
    }

    // 横向溢出。三种算数：整个页面比窗口宽；一个会滚的区域横着滚得动（除了本来就该横着滚的）；
    // 一个会裁的区域里的东西比它宽、被裁掉了（除了有意用省略号截断的）
    const overflow: string[] = []
    const page = document.documentElement
    if (page.scrollWidth > page.clientWidth + 1) {
      overflow.push(`页面 +${page.scrollWidth - page.clientWidth}`)
    }
    for (const element of [root, ...all('*', root)]) {
      const extra = element.scrollWidth - element.clientWidth
      if (extra <= 1 || element.clientWidth === 0 || !shown(element)) continue
      if (element.closest(SCROLLS_BY_DESIGN)) continue
      const style = styleOf(element)
      // 自己不裁也不滚的：多出来的会算到外面那个会裁、会滚的元素头上，不重复记
      if (style.overflowX === 'visible' || style.textOverflow === 'ellipsis') continue
      overflow.push(`${label(element)} +${extra}`)
    }

    // 读不清的字：每一处直接带着字的元素，拿它的字色（半透明的先和底色混）和它底下实际垫着的颜色比
    const backdrop = (element: Element): [number, number, number] => {
      const layers: number[][] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = parse(styleOf(node).backgroundColor)
        if (color[3] <= 0) continue
        layers.push(color)
        if (color[3] >= 1) break
      }
      let base: number[] = layers.at(-1)?.[3] === 1 ? (layers.pop() as number[]) : [255, 255, 255]
      while (layers.length > 0) base = over(layers.pop() as number[], base)
      return [base[0] ?? 0, base[1] ?? 0, base[2] ?? 0]
    }
    const unreadable: string[] = []
    let texts = 0
    let below45 = 0
    let faded = 0
    let lowest = Number.POSITIVE_INFINITY
    let lowestAt = ''
    const done = new Set<Element>()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement
      const words = node.textContent?.trim() ?? ''
      if (!element || !words || done.has(element)) continue
      done.add(element)
      if (!shown(element) || styleOf(element).visibility === 'hidden') continue
      // 有意淡下去的不量：禁用的控件，整块降了透明度的（离线设备下面的会话、用不了的 harness）
      let opacity = 1
      for (let up: Element | null = element; up; up = up.parentElement) {
        opacity *= Number(styleOf(up).opacity)
      }
      if (opacity < 0.99 || element.closest(':disabled, [aria-disabled="true"]')) {
        faded++
        continue
      }
      const under = backdrop(element)
      const ratio = contrast(over(parse(styleOf(element).color), under), under)
      texts++
      if (ratio < 4.5) below45++
      if (ratio < lowest) {
        lowest = ratio
        lowestAt = `${label(element)}「${words.slice(0, 10)}」`
      }
      if (ratio < HARD_LINE) {
        unreadable.push(`${label(element)}「${words.slice(0, 10)}」${ratio.toFixed(2)}`)
      }
    }
    return {
      overflow,
      unreadable,
      texts,
      below45,
      lowest: texts > 0 ? Math.round(lowest * 100) / 100 : 0,
      lowestAt,
      faded,
    }
  }

  const kit: SettingsKit = {
    sleep,
    frame,
    until,
    seen,
    one,
    all,
    text,
    look,
    settled,
    openSession,
    openSettings,
    settingsAt,
    audit,
    where,
  }
  ;(window as unknown as { __setKit: SettingsKit }).__setKit = kit
  return true
}
