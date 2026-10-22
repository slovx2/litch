// 计划模式的验收：底栏上的开关、/plan、模式跟着消息发出去、“计划写好了要不要执行”那一问。
// 接在命令和技能那一组后面，模拟核心和真实入口都跑。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 模拟核心里和真的一样：Codex 出完计划回合就结束（界面来问），Claude Code 和 Pi 出完计划自己接着问，
// dsh 不会计划模式；真实入口的 Pi 上，计划模式开着、话里带“出个计划”时假模型交一份计划
// （scripts/client-fixture-plan.mjs），接着是 Pi 的计划插件自己的那张菜单，选第一项就地实施。

export interface PlanProbe {
  /** 底栏上有计划模式的开关，一开始是关着的 */
  offered: boolean
  /** 点一下开、/plan 关、再 /plan 又开：三次之后开关各是什么样 */
  toggled: boolean[]
  /**
   * 开关画得像开关：元素是 role=switch；关着和开着时拨块离轨道左边多远、轨道是什么底色。
   * 开着时拨块要往右挪、轨道换了颜色，关着时一眼看得出没开
   */
  look: { role: string; off: { knob: number; track: string }; on: { knob: number; track: string } }
  /** 单子上有 /plan */
  listed: boolean
  /** 开着计划模式发消息：对话里出了计划卡片 */
  planned: boolean
  /**
   * 引擎不自己问的（模拟核心里的 Codex）：回合结束之后客户端出了那一问；
   * 它摆得对不对（出的岔子，没有就是空的）；它没有把焦点从输入框拿走。只在模拟核心上量
   */
  asked: boolean | null
  faults: string
  focusKept: boolean
  /** “带意见修改”：焦点进了输入框；写一句发出去之后还在计划模式里，又出了新的一份、又问了一遍。只在模拟核心上量 */
  revised: { focused: boolean; stillPlan: boolean; askedAgain: boolean } | null
  /** “先不执行”：这一问收起来了，计划模式还开着；切走再回来也不再问。只在模拟核心上量 */
  dismissed: { gone: boolean; stillPlan: boolean; stayedGone: boolean } | null
  /** “执行计划”：发出去了一句话，开关关了，这一问没了。只在模拟核心上量 */
  implemented: { said: string; off: boolean; gone: boolean } | null
  /**
   * 真实入口的 Pi：出了计划接着来的是插件的提问卡片，这时客户端不另外问；选第一项之后引擎就地实施，
   * 回话里带着计划里的记号；引擎退出了计划模式，开关跟着关了，回合结束后客户端也不再问。只在真实入口上量
   */
  real: { card: string; noAsk: boolean; carried: boolean; off: boolean; quiet: boolean } | null
  /** 不会计划模式的 harness（dsh）：底栏上没有开关，单子上没有 /plan。只在模拟核心上量 */
  absent: { button: boolean; command: boolean } | null
  /** 单子上有没有 /goal：Codex 会持续目标、Claude Code 会话里没有。只在模拟核心上量 */
  goal: { codex: boolean; claude: boolean } | null
  /**
   * 引擎自己会问的（Claude Code）。只在模拟核心上量：
   * 出了计划接着来的是提问卡片，这时没有客户端的那一问；选“执行”之后开关自己关了；
   * 选“继续规划”之后回合结束，还在计划模式里，客户端不再问一遍
   */
  engine: { card: boolean; noAsk: boolean; offAfterYes: boolean; quietAfterNo: boolean } | null
  /** 新建对话页上打开计划模式再发第一条：建出来的会话在计划模式里，出了计划。只在模拟核心上量 */
  fresh: { button: boolean; planned: boolean; on: boolean } | null
  /**
   * 样子，一种一行：“皮肤/明暗｜横向溢出的像素｜岔子｜对比度：开着的开关上的字、那一问的标题、那一问的说明”。
   * 只在模拟核心上量
   */
  layouts: string[]
}

export async function planProbe(real: boolean): Promise<PlanProbe> {
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
    throw new Error(`计划模式：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const button = () => one<HTMLButtonElement>('.dock .mode-btn[data-kind="plan"]')
  const on = () => button()?.getAttribute('aria-checked') === 'true'
  const ask = () => one('.plan-ask')
  const act = (name: string) => one<HTMLButtonElement>(`.plan-ask [data-act="${name}"]`)
  const plans = () => all('.turn').at(-1)?.querySelectorAll('.plan').length ?? 0
  const idle = () =>
    until('这一轮结束', () => !running() && !one('.req') && area(), 60_000).catch(() => {
      throw new Error(
        `计划模式：等不到这一轮结束（在跑 ${running()}；卡片：${text(one('.req')).slice(0, 200)}；最后一个回合：${text(all('.turn').at(-1)).slice(0, 300)}）`,
      )
    })
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
    await frame()
    const input = await until('输入框', area)
    if (input.value) write(input, '')
    input.focus()
    // 底栏的选项是问来的，等它到（不会计划模式的那个会话上等的是模型的选择器）
    await until('底栏', () => one('.dock .pick[data-kind="model"]'), 10_000).catch(() => null)
    await frame()
    return input
  }
  const say = async (words: string) => {
    const input = await until('输入框', area)
    input.focus()
    write(input, words)
    await frame()
    press(input, 'Enter')
    await until(`“${words}”发出去`, () =>
      all('.umsg-text').some((entry) => text(entry).includes(words)),
    )
  }
  /** 在输入框里叫一条命令 */
  const slash = async (name: string) => {
    const input = await until('输入框', area)
    input.focus()
    write(input, `/${name}`)
    await until(`/${name} 的单子`, () => one('.dock .sug-opt[data-kind="command"]'), 5000)
    press(input, 'Enter')
    await frame()
    await frame()
  }

  const faults = (): string => {
    const found: string[] = []
    const box = ask()?.getBoundingClientRect()
    const cmp = one('.dock .cmp')?.getBoundingClientRect()
    const main = one('.main')?.getBoundingClientRect()
    const field = area()
    if (!box || !cmp || !main || !field) return '那一问或者输入框不在'
    if (box.bottom > cmp.top + 0.5) found.push('那一问压着输入框')
    if (box.top < main.top - 0.5) found.push('那一问伸到了主区域上面')
    if (box.left < main.left - 0.5 || box.right > main.right + 0.5) found.push('那一问伸到左右外面')
    for (const each of all('.plan-ask .btn')) {
      const at = each.getBoundingClientRect()
      if (at.right > box.right + 0.5 || at.bottom > box.bottom + 0.5)
        found.push('按钮伸到那一问外面')
    }
    const at = field.getBoundingClientRect()
    if (document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) !== field) {
      found.push('输入框被盖住了')
    }
    const bar = one('.dock .cmp-bar')
    if (bar && bar.scrollWidth > bar.clientWidth + 1) found.push('底栏横向溢出')
    return found.join('、')
  }

  // ---- 一、开关和 /plan ----
  const main = real ? '给首页加一个状态条' : '核对构建机上的 codex 配置'
  const wish = real ? '出个计划：给首页加一个状态条' : '给首页加一个状态条'
  let input = await open(main)
  await idle()
  const offered = Boolean(await until('计划模式的开关', button, 10_000).catch(() => null)) && !on()
  /** 开关换成这个样子要经过核心走一个来回：等它，等不到就照实记下 */
  const settle = async (wanted: boolean) => {
    await until('开关换过来', () => on() === wanted, 5000).catch(() => null)
    return on()
  }
  /** 拨块离轨道左边多远、轨道的底色 */
  const knob = () => {
    const track = button()?.querySelector('.mode-sw')
    const dot = track?.querySelector('i')
    if (!track || !dot) return { knob: -1, track: '' }
    return {
      knob: Math.round(dot.getBoundingClientRect().left - track.getBoundingClientRect().left),
      track: getComputedStyle(track).backgroundColor,
    }
  }
  // 拨块挪动有一点过渡，等它停下来再量
  const still = async () => {
    await sleep(300)
    return knob()
  }
  const offLook = await still()
  button()?.click()
  const toggled = [await settle(true)]
  const look = { role: button()?.getAttribute('role') ?? '', off: offLook, on: await still() }
  write(input, '/')
  await until('单子', () => one('.dock .sug-opt[data-kind="command"]'), 5000)
  const commands = () => all('.dock .sug-opt[data-kind="command"] b').map((b) => text(b))
  const listed = commands().includes('/plan')
  const codexGoal = commands().includes('/goal')
  await slash('plan')
  toggled.push(await settle(false))
  await slash('plan')
  toggled.push(await settle(true))

  // ---- 二、开着计划模式发消息：出计划，回合结束之后问一句 ----
  await say(wish)
  await until('计划卡片', () => plans() > 0, 20_000).catch(() => {
    throw new Error(
      `计划模式：等不到计划卡片（开关 ${toggled.join()}/${on()}；最后一个回合：${text(all('.turn').at(-1)).slice(0, 200)}；.plan ${all('.plan').length}）`,
    )
  })
  const planned = plans() > 0
  const card = () => (all('.req .opt').length > 0 ? one<HTMLElement>('.req') : null)
  let live: PlanProbe['real'] = null
  if (real) {
    // Pi 的计划插件自己来问：第一项是就地实施
    const shown = await until('计划插件的提问卡片', card, 60_000)
    await frame()
    const noAsk = !ask()
    const said = text(shown).slice(0, 80)
    shown.focus()
    press(shown, '1')
    await until('提问卡片消失', () => !one('.req'), 60_000)
    await idle()
    await until('开关自己关了', () => !on(), 10_000).catch(() => null)
    await sleep(300)
    live = {
      card: said,
      noAsk,
      carried: text(all('.turn').at(-1)).includes('LITCH-PLAN-4827'),
      off: !on(),
      quiet: !ask(),
    }
  }
  await idle()
  if (!real) await until('“计划写好了”那一问', ask, 10_000).catch(() => null)
  await frame()
  const asked = real ? null : Boolean(ask())
  const placed = real ? '' : faults()
  input = await until('输入框', area)
  const focusKept = document.activeElement === input

  // ---- 三、带意见修改、先不执行 ----
  let revised: PlanProbe['revised'] = null
  let dismissed: PlanProbe['dismissed'] = null
  if (!real) {
    document.body.focus()
    ;(document.activeElement as HTMLElement | null)?.blur()
    const firstPlan = ask()?.dataset.plan
    act('revise')?.click()
    await frame()
    const focused = document.activeElement === area()
    await say('第二步先不做')
    await until('新的一份计划', () => plans() > 0 && !running(), 60_000)
    await idle()
    await until('又问了一遍', () => ask() && ask()?.dataset.plan !== firstPlan, 10_000).catch(
      () => null,
    )
    revised = {
      focused,
      stillPlan: on(),
      askedAgain: Boolean(ask()) && ask()?.dataset.plan !== firstPlan,
    }
    act('dismiss')?.click()
    await frame()
    await frame()
    const gone = !ask()
    const stillPlan = on()
    await open('首页文案')
    await open(main)
    await sleep(200)
    dismissed = { gone, stillPlan, stayedGone: !ask() && on() }
    // 再出一份，留给下面的“执行”
    await say('再出一份')
    await until('再出的那一份', () => plans() > 0 && !running(), 60_000)
    await idle()
    await until('“计划写好了”那一问', ask, 10_000)
  }

  // ---- 四、样子（只对着模拟核心）：三种皮肤的深浅色 ----
  const layouts: string[] = []
  if (!real) {
    type Rgba = [number, number, number, number]
    const parse = (color: string): Rgba => {
      const parts = (color.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
      const scale = color.startsWith('color(') ? 255 : 1
      const [r = 0, g = 0, b = 0] = parts.slice(0, 3).map((part) => part * scale)
      return [r, g, b, parts[3] ?? 1]
    }
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ]
    const backdrop = (element: HTMLElement): Rgba => {
      const layers: Rgba[] = []
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color[3] > 0) layers.push(color)
        if (color[3] >= 1) break
      }
      let base: Rgba = parse(getComputedStyle(document.body).backgroundColor)
      for (const layer of layers.reverse()) base = over(layer, base)
      return base
    }
    const luminance = (color: Rgba) => {
      const [r = 0, g = 0, b = 0] = color.slice(0, 3).map((part) => {
        const channel = part / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const readable = (selector: string) => {
      const element = one(selector)
      if (!element) return 0
      const under = backdrop(element)
      const ink = over(parse(getComputedStyle(element).color), under)
      const [high = 0, low = 0] = [luminance(ink), luminance(under)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const overflow = () =>
      Math.max(
        0,
        ...[
          document.documentElement,
          one('.main'),
          one('.dock-in'),
          ask(),
          one('.dock .cmp-bar'),
        ].map((box) => (box ? box.scrollWidth - box.clientWidth : 0)),
      )
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
    for (const skin of ['retro', 'human', 'standard']) {
      for (const theme of ['light', 'dark']) {
        appearance.set({ skin, theme })
        await sleep(200)
        const numbers = [
          readable('.dock .mode-btn[aria-checked="true"] .mode-name'),
          readable('.plan-ask-text b'),
          readable('.plan-ask-text span'),
        ]
        layouts.push(
          `${skin}/${theme}｜${Math.ceil(overflow())}｜${faults()}｜${numbers
            .map((value) => value.toFixed(1))
            .join(':')}`,
        )
      }
    }
    appearance.set(was)
    await sleep(100)
  }

  // ---- 五、执行计划 ----
  let implemented: PlanProbe['implemented'] = null
  if (!real) {
    const turnsBefore = all('.turn').length
    act('implement')?.click()
    await until('执行的那个回合', () => all('.turn').length > turnsBefore, 30_000)
    const said = text(all('.turn').at(-1)?.querySelector('.umsg-text')).slice(0, 200)
    await idle()
    implemented = { said, off: !on(), gone: !ask() }
  }

  // ---- 六、不会计划模式的 harness ----
  let absent: PlanProbe['absent'] = null
  if (!real) {
    input = await open('设备进程的转发开销基准')
    write(input, '/')
    await until('单子', () => one('.dock .sug-opt[data-kind="command"]'), 5000)
    absent = {
      button: Boolean(button()),
      command: all('.dock .sug-opt[data-kind="command"] b').some((b) => text(b) === '/plan'),
    }
    write(input, '')
  }

  // ---- 七、引擎自己会问的 ----
  let engine: PlanProbe['engine'] = null
  let goal: PlanProbe['goal'] = null
  if (!real) {
    input = await open('首页文案')
    await idle()
    write(input, '/')
    await until('单子', () => one('.dock .sug-opt[data-kind="command"]'), 5000)
    goal = { codex: codexGoal, claude: commands().includes('/goal') }
    write(input, '')
    await until('单子收起', () => !one('.dock .sug-opt'), 5000)
    const answer = async (key: string) => {
      const shown = await until('计划确认的提问卡片', card, 60_000)
      await frame()
      const quiet = !ask()
      shown.focus()
      press(shown, key)
      await until('提问卡片消失', () => !one('.req'), 60_000)
      return quiet
    }
    if (!on()) (await until('计划模式的开关', button)).click()
    await until('开关开了', on, 5000)
    await say('先出个计划')
    const noAsk = await answer('1')
    await until('开关自己关了', () => !on(), 10_000).catch(() => null)
    const offAfterYes = !on()
    await idle()
    // 再来一次，这回选“继续规划”：回合结束之后还在计划模式里，客户端不再问一遍
    ;(await until('计划模式的开关', button)).click()
    await until('开关开了', on, 5000)
    await say('再出个计划')
    await answer('2')
    await idle()
    await sleep(300)
    engine = { card: true, noAsk, offAfterYes, quietAfterNo: on() && plans() > 0 && !ask() }
    button()?.click()
    await settle(false)
  }

  // ---- 八、新建对话页 ----
  let fresh: PlanProbe['fresh'] = null
  if (!real) {
    one<HTMLButtonElement>('.sb-link.new')?.click()
    await until('新建对话页', () => one('.new-page .new-hero') && area())
    const had = Boolean(await until('计划模式的开关', button, 10_000).catch(() => null))
    button()?.click()
    await until('开关开了', on, 5000).catch(() => null)
    const opening = '新对话一上来就先出计划'
    const field = await until('新建对话页的输入框', area)
    if (field.value) write(field, '')
    field.focus()
    write(field, opening)
    await frame()
    press(field, 'Enter')
    await until(
      '新会话的第一条消息',
      () => !one('.new-page') && all('.umsg-text').some((entry) => text(entry) === opening),
      60_000,
    )
    await until('新会话里的计划', () => plans() > 0, 60_000).catch(() => null)
    fresh = { button: had, planned: plans() > 0, on: on() }
    // 建在 Claude Code 上的话它会接着问：答掉，别留着
    const pending = await until('这一轮停下来', () => one('.req') || !running(), 60_000)
    if (pending instanceof HTMLElement && pending.classList.contains('req')) {
      pending.focus()
      press(pending, '2')
      await until('提问卡片消失', () => !one('.req'), 60_000)
    }
    await idle()
  }

  return {
    offered,
    toggled,
    look,
    listed,
    planned,
    asked,
    faults: placed,
    focusKept,
    revised,
    dismissed,
    implemented,
    real: live,
    absent,
    goal,
    engine,
    fresh,
    layouts,
  }
}

export function judgePlan(probe: PlanProbe, real: boolean): string[] {
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`计划模式：${what}`)
  }
  check(probe.offered, '底栏上没有计划模式的开关，或者一开始就是开着的')
  check(
    probe.toggled.join() === 'true,false,true',
    `点一下、/plan、再 /plan 之后开关该是开、关、开，实际是 ${probe.toggled.join()}`,
  )
  check(
    probe.look.role === 'switch' &&
      probe.look.on.knob > probe.look.off.knob &&
      probe.look.on.track !== probe.look.off.track,
    `计划模式的开关关着和开着该看得出来（role=switch，开着时拨块往右、轨道换色），实际是 ${JSON.stringify(probe.look)}`,
  )
  check(probe.listed, '单子上没有 /plan')
  check(probe.planned, '开着计划模式发消息，对话里没有出计划')
  if (!real) check(probe.asked === true, '计划写好了，没有问要不要执行')
  check(probe.faults === '', `“计划写好了”那一问摆得不对：${probe.faults}`)
  check(probe.focusKept, '“计划写好了”那一问把焦点从输入框拿走了')
  if (probe.revised) {
    check(probe.revised.focused, '点“带意见修改”，焦点没有进输入框')
    check(probe.revised.stillPlan, '带着意见发出去之后计划模式关了')
    check(probe.revised.askedAgain, '带着意见发出去、出了新的一份之后没有再问')
  }
  if (probe.dismissed) {
    check(probe.dismissed.gone, '点了“先不执行”，那一问还在')
    check(probe.dismissed.stillPlan, '点了“先不执行”，计划模式跟着关了')
    check(probe.dismissed.stayedGone, '点了“先不执行”，切走再回来又问了一遍')
  }
  if (probe.implemented) {
    check(
      probe.implemented.said === '按这份计划执行。',
      `点了“执行计划”，发的话不对：“${probe.implemented.said}”`,
    )
    check(probe.implemented.off, '执行计划之后计划模式还开着')
    check(probe.implemented.gone, '执行计划之后那一问还在')
  }
  if (probe.real) {
    check(probe.real.card.length > 0, '真实入口：出了计划之后引擎没有来问')
    check(probe.real.noAsk, '真实入口：引擎自己在问的时候，客户端也问了一遍')
    check(probe.real.carried, '真实入口：选了就地实施，回话里没有计划里的记号')
    check(probe.real.off, '真实入口：引擎退出了计划模式，底栏的开关没有跟着关')
    check(probe.real.quiet, '真实入口：引擎问过了，回合结束后客户端又问了一遍')
  }
  if (probe.absent) {
    check(!probe.absent.button, '不会计划模式的 harness 上出了开关')
    check(!probe.absent.command, '不会计划模式的 harness 上单子里有 /plan')
  }
  if (probe.goal) {
    check(probe.goal.codex, 'Codex 会话的单子上没有 /goal')
    check(!probe.goal.claude, 'Claude Code 会话的单子上有 /goal')
  }
  if (probe.engine) {
    check(probe.engine.noAsk, '引擎自己在问的时候，客户端也问了一遍')
    check(probe.engine.offAfterYes, '引擎那一问选了“执行”，开关没有跟着关')
    check(
      probe.engine.quietAfterNo,
      '引擎那一问选了“继续规划”，回合结束后客户端又问了一遍（或者计划模式没了）',
    )
  }
  if (probe.fresh) {
    check(probe.fresh.button, '新建对话页上没有计划模式的开关')
    check(
      probe.fresh.planned && probe.fresh.on,
      '新建对话页上开着计划模式发第一条，建出来的会话不在计划模式里',
    )
  }
  if (!real && probe.layouts.length !== 6)
    check(false, `该量 6 种样子，量了 ${probe.layouts.length} 种`)
  for (const line of probe.layouts) {
    const [which = '', spill = '', faults = '', numbers = ''] = line.split('｜')
    if (spill !== '0') failed.push(`计划模式的样子（${which}）：横向溢出 ${spill} 像素`)
    if (faults) failed.push(`计划模式的样子（${which}）：${faults}`)
    const [pressed = 0, title = 0, note = 0] = numbers.split(':').map(Number)
    for (const [label, value, least] of [
      ['开着的开关上的字', pressed, 4.5],
      ['那一问的标题', title, 4.5],
      ['那一问的说明', note, 4.5],
    ] as const) {
      if (value < least) failed.push(`计划模式的样子（${which}）：${label}和底色分不开（${value}）`)
    }
  }
  return failed
}
