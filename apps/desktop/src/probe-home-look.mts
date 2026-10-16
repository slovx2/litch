// 新建对话页的样子：中英文、三种皮肤的深浅色、能建和建不了两种状态下，版面有没有出岔子。
// 只对着模拟核心量（要一台没连上的设备）。接在 probe-home.mts 后面跑；起自检的一方把窗口缩到最小再跑一遍。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 不看输入框自己的 scrollHeight：它的高度只在字变的时候重量，直接改皮肤属性不会触发，量出来不作数。

export interface HomeLook {
  /** 量的时候窗口里面有多宽、多高 */
  width: number
  height: number
  /** 英文界面里的几处字：提示语｜两个标签｜标题栏最后一段｜侧栏最上面的入口｜建不了时的那句话 */
  english: string
  /** 换回中文之后的提示语 */
  chinese: string
  /**
   * 一种一行：“状态/语言/皮肤/明暗｜横向溢出的像素｜版面出的岔子（没有就是空的）｜提示语的对比度:标签的对比度”。
   * 状态是“能建”（本机）和“建不了”（一台没连上的设备，多出一句话和一块说明）
   */
  layouts: string[]
}

export async function homeLook(): Promise<HomeLook> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 10_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`新建对话页的样子：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const options = () => all('.pick[data-kind="device"] .pick-opt')
  /** 在页上把设备换成标识是这个的那一台（换了语言名字会变，标识不变） */
  const device = async (id: string) => {
    const button = await until('选设备的选择器', () =>
      one<HTMLButtonElement>('.pick[data-kind="device"] .pick-btn'),
    )
    button.click()
    const option = await until('那台设备', () =>
      options().find((entry) => entry.dataset.option === id),
    )
    option.click()
    await until('选择器收起', () => options().length === 0)
  }

  // 等窗口的大小定下来（起自检的一方可能刚改过）
  const settle = performance.now() + 5000
  let last = ''
  while (performance.now() < settle) {
    await sleep(120)
    const size = `${window.innerWidth}x${window.innerHeight}`
    if (size === last) break
    last = size
  }
  one<HTMLButtonElement>('.sb-link.new')?.click()
  await until('新建对话页', () => one('.new-hero') && one('.new-place'))

  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const channel = Number(part) / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  /** 一个元素底下实际垫着的颜色：自己没有底色就往外找 */
  const backdrop = (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color
    }
    return getComputedStyle(document.body).backgroundColor
  }
  const readable = (selector: string) => {
    const element = one(selector)
    return element ? contrast(getComputedStyle(element).color, backdrop(element)) : 0
  }
  /** 横向溢出了多少：页面、主区域、这一页、输入区那一栏 */
  const overflow = () =>
    Math.max(
      0,
      ...[document.documentElement, one('.main'), one('.new-page'), one('.dock-in')].map((box) =>
        box ? box.scrollWidth - box.clientWidth : 0,
      ),
    )
  /**
   * 版面出的岔子：从上到下应该是提示语、输入框、选去处的一排、（建不了时的）那句话、说明，
   * 一样压不着一样，都在这一页里面；提示语没被裁掉；选去处的两个选择器没伸到那一排外面
   */
  const faults = (blocked: boolean) => {
    const page = one('.new-page')?.getBoundingClientRect()
    if (!page) return '没有这一页'
    const found: string[] = []
    const parts: [string, string][] = [
      ['提示语', '.new-hero h1'],
      ['输入框', '.dock .cmp'],
      ['选去处的一排', '.dock .new-place'],
      ...(blocked
        ? ([
            ['那句话', '.dock .cmp-hint.err'],
            ['说明', '.dock .new-why'],
          ] as [string, string][])
        : []),
    ]
    let floor = page.top
    let above = '这一页的上边'
    for (const [name, selector] of parts) {
      const box = one(selector)?.getBoundingClientRect()
      if (!box || box.width === 0 || box.height === 0) {
        found.push(`没有${name}`)
        continue
      }
      if (box.top < floor - 0.5) found.push(`${name}压着${above}`)
      if (box.left < page.left - 0.5 || box.right > page.right + 0.5)
        found.push(`${name}伸到左右外面`)
      if (box.bottom > page.bottom + 0.5) found.push(`${name}伸到下面外面`)
      floor = box.bottom
      above = name
    }
    const hero = one('.new-hero')?.getBoundingClientRect()
    const line = one('.new-hero h1')?.getBoundingClientRect()
    if (hero && line && (line.top < hero.top - 0.5 || line.left < hero.left - 0.5)) {
      found.push('提示语被裁掉了')
    }
    const bar = one('.dock .new-place')?.getBoundingClientRect()
    for (const button of all('.dock .new-place .pick-btn')) {
      const box = button.getBoundingClientRect()
      if (bar && (box.right > bar.right + 0.5 || box.left < bar.left - 0.5)) {
        found.push('选择器伸到那一排外面')
      }
    }
    if (blocked && !one('.new-why [data-act="open-devices"]')) found.push('没有去设备页的按钮')
    return found.join('、')
  }

  // 换皮肤、明暗、语言走界面给验收留的口子，不靠界面上哪个按钮
  const look = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const before = look.get()
  const layouts: string[] = []
  let english = ''
  for (const [state, id] of [
    ['能建', 'local'],
    ['建不了', 'gpu'],
  ] as const) {
    await device(id)
    if (id === 'gpu') await until('建不了的说明', () => one('.new-why'))
    for (const [language, lang] of [
      ['中文', 'zh-CN'],
      ['英文', 'en'],
    ] as const) {
      look.set({ lang })
      await sleep(200)
      for (const skin of ['retro', 'human', 'standard']) {
        for (const theme of ['light', 'dark']) {
          look.set({ skin, theme })
          await sleep(200)
          const numbers = [readable('.new-hero h1'), readable('.new-place-label')]
          layouts.push(
            `${state}/${language}/${skin}/${theme}｜${Math.ceil(overflow())}｜${faults(
              id === 'gpu',
            )}｜${numbers.map((value) => value.toFixed(1)).join(':')}`,
          )
        }
      }
      if (language === '英文' && id === 'gpu') {
        english = [
          text(one('.new-hero h1')),
          all('.new-place-label').map(text).join('/'),
          text(one('.crumb b')),
          text(one('.sb-link.new')),
          text(one('.dock .cmp-hint.err')),
        ].join('｜')
      }
    }
  }
  look.set({ skin: before.skin, theme: before.theme, lang: before.lang })
  await device('local')
  await sleep(100)
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    english,
    chinese: text(one('.new-hero h1')),
    layouts,
  }
}

/** wide 是平常大小的窗口里量的，narrow 是缩到允许的最小之后量的 */
export function judgeHomeLook(wide: HomeLook, narrow: HomeLook, minWidth: number): string[] {
  const failed: string[] = []
  const [hero = '', labels = '', title = '', entry = '', hint = ''] = wide.english.split('｜')
  if (hero !== 'What magic shall we cast today') {
    failed.push(`英文界面的提示语不对：“${hero}”`)
  }
  if (labels !== 'Device/Workspace') failed.push(`英文界面里选去处的两个标签不对：“${labels}”`)
  if (title !== 'New session' || entry !== 'New session') {
    failed.push(`英文界面的标题栏或者侧栏入口不对：“${title}”“${entry}”`)
  }
  if (!hint.includes('gpu-box') || /[一-鿿]/.test(hint)) {
    failed.push(`英文界面里建不了的那句话不对：“${hint}”`)
  }
  if (wide.chinese !== '今天要施展什么魔法')
    failed.push(`换回中文之后提示语不对：“${wide.chinese}”`)
  if (narrow.width > minWidth) {
    failed.push(`窗口没有缩到最窄：还有 ${narrow.width}，最窄是 ${minWidth}`)
  }
  for (const [name, look] of [
    ['平常大小', wide],
    ['最小的窗口', narrow],
  ] as const) {
    if (look.layouts.length !== 24)
      failed.push(`${name}：该量 24 种样子，量了 ${look.layouts.length} 种`)
    for (const line of look.layouts) {
      const [which = '', spill = '', faults = '', numbers = ''] = line.split('｜')
      if (spill !== '0') failed.push(`${name} ${which}：横向溢出 ${spill} 像素`)
      if (faults) failed.push(`${name} ${which}：${faults}`)
      const [heroContrast = 0, labelContrast = 0] = numbers.split(':').map(Number)
      if (heroContrast < 7) failed.push(`${name} ${which}：提示语和底色分不开（${heroContrast}）`)
      if (labelContrast < 3) failed.push(`${name} ${which}：标签和底色分不开（${labelContrast}）`)
    }
  }
  return failed
}
