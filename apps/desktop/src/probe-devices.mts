// 设备列表的验收，对着模拟核心：一行上只有一眼要看的那几样，整行就是进详情的入口；
// 忙闲和最近活动跟着会话变；六套皮肤明暗组合下不横向溢出、字和底分得开；窗口缩到最窄也不溢出。
// 模拟核心里有四台设备：本机（四个 harness，一个不可用）、build（五个 harness）、
// nas（只有一个 harness）、gpu（没连上）。发的话里带“审批”的回合会停下来等人，带“待办”的要跑好一会儿。
// 和别的验收一样，devicesProbe、narrowDevicesProbe 会被原样送进页面里执行，不能引用函数外面的东西；
// judgeDevices 在主进程里跑。

export interface DevicesProbe {
  /** 每一行上的字：标识｜名字｜主机｜状态｜harness 概况｜徽标（用不了的带 *） */
  rows: string[]
  /** 每一行的构成：标识:按钮数（整行那一个）:别的控件数:不该在行上的东西数:行尾的箭头 */
  shape: string[]
  /** 没连上的那台：忙闲那一栏空着，harness 那一栏淡一档 */
  offlineRow: string
  /** 每一行都是聚焦得到的按钮；聚焦之后按下去进了详情；Esc 回到列表，焦点落回那一行 */
  rowsFocusable: boolean
  opened: string
  focusBack: boolean
  /** 详情里的返回按钮也回到列表，焦点同样落回那一行 */
  backButton: boolean
  /**
   * build 那一行的忙闲和最近活动，一路上各是什么（在跑/在等｜最近活动）：
   * 开头 → 一个会话停下来等审批 → 同意之后 → 一个回合在跑 → 跑完
   */
  busy: string[]
  /** 那几步里忙闲一栏写的字 */
  busyText: string[]
  /** 侧栏里没有一直占着地方的说明框 */
  sidebarNotes: number
  /** 六套皮肤明暗：横向溢出了多少像素｜名字、主机小字、在跑的字、最近活动 各自和底色的对比 */
  skins: string[]
}

export interface NarrowDevicesProbe {
  /** 量的时候页面有多宽、列表有多宽 */
  width: number
  listWidth: number
  /** 两种语言乘六套皮肤明暗：溢出的像素｜名字露出来的宽度｜状态在不在｜还露着的栏 */
  layouts: string[]
}

export async function devicesProbe(): Promise<DevicesProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const press = (target: Element, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const item = (id: string) => one(`.devp-item[data-device="${id}"]`) as HTMLElement
  const rowOf = (id: string) => one<HTMLButtonElement>('.devp-row', item(id)) as HTMLButtonElement
  /** 打开设备列表。还停在某台设备的详情里就先退出来 */
  const openList = async () => {
    one<HTMLButtonElement>('.sb-link.devices')?.click()
    await frame()
    one<HTMLButtonElement>('[data-detail] [data-act="back"]')?.click()
    await until('设备列表', () => !one('[data-detail]') && all('.devp-item').length >= 4)
  }

  // ---- 一、一行上只有那几样 ----
  await openList()
  const rows = all('.devp-item').map((entry) =>
    [
      entry.dataset.device,
      text(one('.devp-name', entry)),
      text(one('.devp-who .devp-sub', entry)),
      text(one('.devp-state', entry)),
      text(one('.devp-has .devp-sub', entry)),
      [...all('.devp-chips .chip', entry), ...all('.devp-more', entry)]
        .map((chip) => `${text(chip)}${chip.classList.contains('off') ? '*' : ''}`)
        .join(' '),
    ].join('｜'),
  )
  const shape = all('.devp-item').map((entry) =>
    [
      entry.dataset.device,
      all('button', entry).length,
      all('input, select, textarea, a, form, dialog, [role="switch"], [role="radio"]', entry)
        .length,
      all(
        '.wires, .cfail, .harness-why, .harness-entry, .devp-note, .devp-facts, .devp-acts',
        entry,
      ).length,
      one('.devp-row > svg.ic:last-child', entry) ? '箭头' : '没有箭头',
    ].join(':'),
  )
  const gone = one('.devp-busy', item('gpu'))
  const offlineRow = `${text(gone)}｜${gone?.dataset.running ?? '不知道'}｜${
    Number(getComputedStyle(one('.devp-has', item('gpu')) as HTMLElement).opacity) < 1
      ? '淡一档'
      : '没变淡'
  }`
  const sidebarNotes = all('.dev-group:not(.off) .dev-note').length

  // ---- 二、整行可点，键盘够得着 ----
  const buttons = all('.devp-row') as HTMLButtonElement[]
  const rowsFocusable = buttons.every((button) => {
    button.focus()
    return (
      button.tagName === 'BUTTON' &&
      !button.disabled &&
      button.tabIndex === 0 &&
      document.activeElement === button
    )
  })
  // 聚焦在按钮上按回车，浏览器给的就是一次点击
  rowOf('build').focus()
  rowOf('build').click()
  const opened =
    (await until('build 的详情', () => one('[data-detail]'))).getAttribute('data-detail') ?? ''
  press(document.body, 'Escape')
  await until('回到列表', () => !one('[data-detail]') && item('build'))
  await frame()
  const focusBack = document.activeElement === rowOf('build')
  rowOf('nas').click()
  await until('nas 的详情', () => one('[data-detail="nas"]'))
  one<HTMLButtonElement>('[data-detail] [data-act="back"]')?.click()
  await until('回到列表', () => !one('[data-detail]') && item('nas'))
  await frame()
  const backButton = document.activeElement === rowOf('nas')

  // ---- 三、忙闲和最近活动跟着会话变 ----
  const build = () => all('.dev-group')[1] as HTMLElement
  const cell = () => one('.devp-busy', item('build'))
  const counts = () => `${cell()?.dataset.running}/${cell()?.dataset.waiting}`
  const busy: string[] = []
  const busyText: string[] = []
  const mark = () => {
    busy.push(`${counts()}｜${text(one('.devp-when', item('build')))}`)
    busyText.push(text(cell()))
  }
  const [running = 0, waiting = 0] = counts().split('/').map(Number)
  mark()
  // 挑一个闲着的会话：不在跑、没在等人
  const idle = all('.ss-row', build()).find(
    (entry) =>
      !entry.classList.contains('down') && !one('.st.run, .st.wait, .st.err, .pill.wait', entry),
  )
  if (!idle) throw new Error('build 上没有闲着的会话')
  const title = text(one('.title', idle))
  const open = async () => {
    all('.ss-row', build())
      .find((entry) => text(one('.title', entry)) === title)
      ?.click()
    await until('打开这个会话', () => text(one('.crumb b')) === title)
  }
  const say = async (words: string) => {
    await open()
    const input = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, words)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    press(input, 'Enter')
    await frame()
  }
  await say('这一步要一次审批')
  await until('审批卡片', () => one('.req'))
  await openList()
  await until('多了一个在等人的', () => counts() === `${running}/${waiting + 1}`)
  mark()
  await open()
  ;(
    await until('审批卡片上的“同意”', () =>
      one<HTMLButtonElement>('.req .req-actions .btn.primary'),
    )
  ).click()
  await until('这个回合结束', () => !one('.req') && !one('.running-line'))
  await openList()
  await until('等人的少了一个', () => counts() === `${running}/${waiting}`)
  mark()
  await say('列一份待办慢慢做')
  await openList()
  await until('多了一个在跑的', () => counts() === `${running + 1}/${waiting}`)
  mark()
  await until('跑完了', () => counts() === `${running}/${waiting}`, 90_000)
  mark()

  // ---- 四、六套皮肤明暗：不横向溢出，字和底分得开 ----
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
    const element = one(selector) as HTMLElement
    return contrast(getComputedStyle(element).color, backdrop(element))
  }
  /** 横向溢出了多少：页面、滚动的那一层、列表、每一行，还有每一行里伸到列表右边外面去的东西 */
  const overflow = () => {
    const list = one('.devp-list') as HTMLElement
    const edge = list.getBoundingClientRect().right
    const boxes = [
      document.documentElement,
      one('.arch-body') as HTMLElement,
      list,
      ...all('.devp-row'),
    ]
    const inner = all('.devp-row > *').map((entry) => entry.getBoundingClientRect().right - edge)
    return Math.max(0, ...boxes.map((box) => box.scrollWidth - box.clientWidth), ...inner)
  }
  // 换皮肤和明暗走界面给验收留的口子，不靠界面上哪个按钮
  const look = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const before = look.get()
  const skins: string[] = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      look.set({ skin, theme })
      await sleep(250)
      const numbers = [
        readable('.devp-name'),
        readable('.devp-who .devp-sub'),
        readable('.devp-running'),
        readable('.devp-when'),
      ]
      skins.push(
        `${skin}/${theme}｜${Math.ceil(overflow())}｜${numbers.map((value) => value.toFixed(1)).join(':')}`,
      )
    }
  }
  look.set({ skin: before.skin, theme: before.theme })

  return {
    rows,
    shape,
    offlineRow,
    rowsFocusable,
    opened,
    focusBack,
    backButton,
    busy,
    busyText,
    sidebarNotes,
    skins,
  }
}

/** 窗口缩到允许的最窄之后接着量（窗口由起自检的一方缩好）。进来的时候设备列表开着 */
export async function narrowDevicesProbe(): Promise<NarrowDevicesProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const overflow = () => {
    const list = one('.devp-list') as HTMLElement
    const edge = list.getBoundingClientRect().right
    const boxes = [
      document.documentElement,
      one('.arch-body') as HTMLElement,
      list,
      ...all('.devp-row'),
    ]
    const inner = all('.devp-row > *')
      .filter((entry) => entry.getClientRects().length > 0)
      .map((entry) => entry.getBoundingClientRect().right - edge)
    return Math.max(0, ...boxes.map((box) => box.scrollWidth - box.clientWidth), ...inner)
  }
  const shown = (element: HTMLElement | null) =>
    Boolean(element && element.getClientRects().length > 0)
  // 等窗口真的变窄、版面跟上
  const settle = performance.now() + 5000
  let last = -1
  while (performance.now() < settle) {
    await sleep(120)
    if (window.innerWidth === last) break
    last = window.innerWidth
  }
  // 换皮肤、明暗、语言走界面给验收留的口子，不靠界面上哪个按钮。中文量一遍，英文（字更长）量一遍
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
        const names = all('.devp-name').map((entry) => entry.clientWidth)
        const states = all('.devp-item').every((entry) => shown(one('.devp-state .pill', entry)))
        const columns = ['.devp-has', '.devp-busy', '.devp-when']
          .filter((selector) => shown(one(selector)))
          .join('+')
        layouts.push(
          `${language}/${skin}/${theme}｜${Math.ceil(overflow())}｜${Math.min(...names)}｜${
            states ? '状态在' : '状态没了'
          }｜${columns}`,
        )
      }
    }
  }
  look.set({ skin: before.skin, theme: before.theme, lang: before.lang })
  await sleep(200)
  return {
    width: window.innerWidth,
    listWidth: (one('.devp-list') as HTMLElement).clientWidth,
    layouts,
  }
}

/** 量到的东西里哪些算不合格。minWidth：窗口允许的最小宽度 */
export function judgeDevices(
  probe: DevicesProbe,
  narrow: NarrowDevicesProbe,
  minWidth: number,
): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const same = (actual: unknown, expected: unknown, what: string) =>
    must(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`,
    )

  same(
    probe.rows,
    [
      'local｜本机｜dev@macbook｜已连接｜4 个 harness｜CC PI DS CX*',
      // build-01 上有五个：徽标只摆四个，多的记个数
      'build｜build-01｜dev@build-01｜已连接｜5 个 harness｜CC PI DS CX +1',
      // 没有设备服务、只连着原生 codex 的远程设备：说“只有它”
      'nas｜nas｜admin@nas.lan｜已连接｜只有 Codex｜CX',
      'gpu｜gpu-box｜dev@gpu-box｜离线｜2 个 harness｜CC PI',
    ],
    '设备列表一行上的字不对（标识｜名字｜主机｜状态｜harness 概况｜徽标）',
  )
  same(
    probe.shape,
    ['local:1:0:0:箭头', 'build:1:0:0:箭头', 'nas:1:0:0:箭头', 'gpu:1:0:0:箭头'],
    '设备列表的一行上有不该有的东西（标识:按钮数:别的控件数:该在详情里的东西数:行尾）',
  )
  must(
    probe.offlineRow === '｜不知道｜淡一档',
    `没连上的那一行不对（忙闲那一栏的字｜在跑的个数｜harness 那一栏）：${probe.offlineRow}`,
  )
  must(probe.sidebarNotes === 0, `侧栏里连着的设备下面还有说明框：${probe.sidebarNotes} 个`)
  must(probe.rowsFocusable, '设备列表的行不都是键盘聚焦得到的按钮')
  must(probe.opened === 'build', `点一行没有进它的详情：${probe.opened}`)
  must(probe.focusBack, '按 Esc 从详情回到列表，焦点没有落回那一行')
  must(probe.backButton, '按返回从详情回到列表，焦点没有落回那一行')

  const steps = probe.busy.map((entry) => {
    const [counts = '', when = ''] = entry.split('｜')
    const [running = Number.NaN, waiting = Number.NaN] = counts.split('/').map(Number)
    return { running, waiting, when }
  })
  const [start, asked, answered, working, done] = steps
  must(
    steps.length === 5 &&
      start !== undefined &&
      asked?.waiting === start.waiting + 1 &&
      answered?.waiting === start.waiting &&
      working?.running === start.running + 1 &&
      done?.running === start.running &&
      done.waiting === start.waiting,
    `忙闲没有跟着会话变（在跑/在等｜最近活动）：${JSON.stringify(probe.busy)}`,
  )
  must(
    start?.when !== '现在' && steps.slice(1).every((step) => step.when === '现在'),
    `最近活动没有跟着会话变：${JSON.stringify(probe.busy)}`,
  )
  must(
    (probe.busyText[1] ?? '').includes(`${(start?.waiting ?? 0) + 1} 个在等你`) &&
      (probe.busyText[3] ?? '').includes(`${(start?.running ?? 0) + 1} 个在跑`),
    `忙闲那一栏没有把在等人的、在跑的写出来：${JSON.stringify(probe.busyText)}`,
  )

  for (const line of probe.skins) {
    const [where, over, numbers = ''] = line.split('｜')
    const [name, host, running, when] = numbers.split(':').map(Number)
    must(over === '0', `${where} 下设备列表横向溢出了 ${over} 像素`)
    must(
      (name ?? 0) >= 4.5 && (host ?? 0) >= 3 && (running ?? 0) >= 4.5 && (when ?? 0) >= 3,
      `${where} 下设备列表的字和底分不开（名字 ${name}、主机 ${host}、在跑 ${running}、最近活动 ${when}）`,
    )
  }
  must(probe.skins.length === 6, `皮肤没有量全：${probe.skins.length}`)

  must(narrow.width <= minWidth, `窗口没有缩到最窄（${minWidth}）：页面宽 ${narrow.width}`)
  for (const line of narrow.layouts) {
    const [where, over, name, state, columns = ''] = line.split('｜')
    must(over === '0', `最窄的窗口里，${where} 下设备列表横向溢出了 ${over} 像素`)
    // 名字和状态留到最后：名字至少露出四五个字的宽度
    must(
      Number(name) >= 64 && state === '状态在',
      `最窄的窗口里，${where} 下名字或状态被挤没了（名字露出 ${name} 像素，${state}）`,
    )
    // 先收的是最右边的次要栏：harness 一栏比忙闲留得久，忙闲比最近活动留得久
    must(
      ['.devp-has+.devp-busy+.devp-when', '.devp-has+.devp-busy', '.devp-has', ''].includes(
        columns,
      ),
      `最窄的窗口里，${where} 下收栏的次序不对：还露着 ${columns}`,
    )
  }
  must(narrow.layouts.length === 12, `最窄的窗口里没有量全：${narrow.layouts.length}`)
  return failed
}
