// 侧栏验收在页面里用的那套手：等、找、读、点、鼠标停到一行上、换皮肤。装一次，后面几段都用它。
// 和别的验收一样，installSidebarKit 会被原样送进页面里执行，不能引用函数外面的东西；
// 页面重新加载之后（核心重启）要再装一次。

export interface SidebarKit {
  sleep(ms: number): Promise<void>
  frame(): Promise<void>
  /** 等到 check 给出东西为止，返回它；到点还没有就报错，带上等的是什么 */
  until<T>(what: string, check: () => T | null | undefined | false, ms?: number): Promise<T>
  /** 等到 check 成立，返回等到了没有（不报错） */
  seen(check: () => unknown, ms?: number): Promise<boolean>
  one<E extends Element = HTMLElement>(selector: string, root?: ParentNode): E | null
  all(selector: string, root?: ParentNode): HTMLElement[]
  text(element: Element | null | undefined): string
  press(target: Element, key: string): void
  /** 侧栏里的一台设备（按设备标识找），和它自己的那一行 */
  device(id: string): HTMLElement
  deviceLine(id: string): HTMLElement
  /** 这台设备下面的一个项目那一行（按名字找） */
  workspaceLine(deviceId: string, name: string): HTMLElement
  /** 一行里那个管展开收起的按钮现在是不是展开着 */
  expanded(line: Element): boolean
  /** 把一行收起或者展开，等它变过去 */
  fold(line: Element, open: boolean): Promise<void>
  /** 这台设备下面画出来的会话的标题，从上到下 */
  titles(deviceId: string): string[]
  /** 按标题找侧栏里的一行会话 */
  row(title: string): HTMLElement | undefined
  /** 打开侧栏里的一个会话，等它的内容出来 */
  open(title: string): Promise<void>
  /** 在眼前的会话里说一句 */
  say(words: string): Promise<void>
  /** 鼠标停到一行上，等信息卡出来。看完调 close 让它收起 */
  hover(line: Element, what: string): Promise<{ card: HTMLElement; close(): Promise<void> }>
  /** 两个颜色的对比度 */
  contrast(a: string, b: string): number
  /** 一个元素底下实际看到的颜色：自己没有底色就往外找；半透明的底色叠到更外面的底色上再算 */
  backdrop(element: HTMLElement): string
  /** 六套皮肤明暗各摆一遍、各量一次，量完换回原来的 */
  eachSkin<T>(measure: (where: string) => T | Promise<T>): Promise<T[]>
}

export function installSidebarKit(): void {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until: SidebarKit['until'] = async (what, check, ms = 30_000) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}`)
  }
  const seen: SidebarKit['seen'] = async (check, ms = 5000) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      if (check()) return true
      await sleep(16)
    }
    return false
  }
  const one: SidebarKit['one'] = (selector, root = document) => root.querySelector(selector)
  const all: SidebarKit['all'] = (selector, root = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text: SidebarKit['text'] = (element) => element?.textContent?.trim() ?? ''
  const press: SidebarKit['press'] = (target, key) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }
  const device: SidebarKit['device'] = (id) => {
    const found = one(`.dev-group[data-device="${id}"]`)
    if (!found) throw new Error(`侧栏里没有设备 ${id}`)
    return found
  }
  const deviceLine: SidebarKit['deviceLine'] = (id) =>
    one(':scope > .row-line', device(id)) as HTMLElement
  const workspaceLine: SidebarKit['workspaceLine'] = (deviceId, name) => {
    const found = all('[data-workspace]', device(deviceId)).find(
      (line) => text(one('.name', line)) === name,
    )
    if (!found) throw new Error(`${deviceId} 下面没有项目“${name}”`)
    return found
  }
  const toggle = (line: Element) => one<HTMLButtonElement>('[aria-expanded]', line)
  const expanded: SidebarKit['expanded'] = (line) =>
    toggle(line)?.getAttribute('aria-expanded') === 'true'
  const fold: SidebarKit['fold'] = async (line, open) => {
    if (expanded(line) === open) return
    toggle(line)?.click()
    await until(open ? '这一行展开' : '这一行收起', () => expanded(line) === open, 5000)
    await frame()
  }
  // 设备那一组还没画出来就是一条都没有，不抛错：这个是拿来等的（页面刚起来、核心刚重启的那一刻）
  const titles: SidebarKit['titles'] = (deviceId) => {
    const group = one(`.dev-group[data-device="${deviceId}"]`)
    return group ? all('.ss-row .title', group).map(text) : []
  }
  const row: SidebarKit['row'] = (title) =>
    all('.ss-row').find((entry) => text(one('.title', entry)) === title)
  const open: SidebarKit['open'] = async (title) => {
    ;(await until(`侧栏里的“${title}”`, () => row(title))).click()
    await until(`“${title}”的内容`, () => text(one('.crumb b')) === title && one('.turn'))
    await frame()
  }
  const say: SidebarKit['say'] = async (words) => {
    const input = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, words)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    press(input, 'Enter')
    await frame()
  }
  const hover: SidebarKit['hover'] = async (line, what) => {
    line.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    const card = await until(`${what}的信息卡`, () => one<HTMLElement>('.info-card'), 10_000)
    return {
      card,
      close: async () => {
        line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        await until('信息卡收起', () => !one('.info-card'), 5000)
      },
    }
  }
  /**
   * 浏览器算出来的一个颜色读成三个 0 到 255 的数和一个透明度。
   * 两种写法都会遇到：rgb()/rgba()，和 color-mix 算出来的 color(srgb …)（那种是 0 到 1 的数）
   */
  const channels = (color: string): number[] => {
    const numbers = (color.match(/[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
    const [r = 0, g = 0, b = 0, alpha = 1] = numbers
    const scale = color.startsWith('color(') ? 255 : 1
    return [r * scale, g * scale, b * scale, color === 'transparent' ? 0 : alpha]
  }
  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = channels(color)
      .slice(0, 3)
      .map((part) => {
        const channel = part / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast: SidebarKit['contrast'] = (a, b) => {
    const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  const backdrop: SidebarKit['backdrop'] = (element) => {
    // 从里往外收集一层层的底色，收到一层不透明的为止；再从外往里叠
    const layers: number[][] = []
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const layer = channels(getComputedStyle(node).backgroundColor)
      if (layer[3] === 0) continue
      layers.push(layer)
      if (layer[3] === 1) break
    }
    let mixed = [255, 255, 255]
    for (const [r = 0, g = 0, b = 0, alpha = 1] of layers.reverse()) {
      mixed = [r, g, b].map((channel, at) => channel * alpha + (mixed[at] ?? 0) * (1 - alpha))
    }
    return `rgb(${mixed.map(Math.round).join(', ')})`
  }
  const eachSkin: SidebarKit['eachSkin'] = async (measure) => {
    // 换皮肤、明暗、语言走界面给验收留的口子（window.__litchLook），不直接改根元素上的属性
    const appearance = (
      window as unknown as {
        __litchLook: {
          get(): { skin: string; theme: string; lang: string }
          set(patch: { skin?: string; theme?: string; lang?: string }): void
        }
      }
    ).__litchLook
    const was = appearance.get()
    const results = []
    for (const skin of ['retro', 'human', 'standard']) {
      for (const theme of ['light', 'dark']) {
        appearance.set({ skin, theme })
        await sleep(200)
        results.push(await measure(`${skin}/${theme}`))
      }
    }
    appearance.set(was)
    await sleep(200)
    return results
  }
  const kit: SidebarKit = {
    sleep,
    frame,
    until,
    seen,
    one,
    all,
    text,
    press,
    device,
    deviceLine,
    workspaceLine,
    expanded,
    fold,
    titles,
    row,
    open,
    say,
    hover,
    contrast,
    backdrop,
    eachSkin,
  }
  ;(window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit = kit
}
