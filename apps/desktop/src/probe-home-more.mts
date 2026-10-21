// 新建对话页上后补的两件事，只对着模拟核心量，接在 probe-home.mts 后面（那一组刚在 build-01 的 infra 里
// 用 Pi 建过一个会话，这里的默认值是从它记下的东西来的）：
// 一、建在哪个 harness 上是按项目记的：没用过的项目拿这台设备最近用的，用过的各记各的；
//     这次只是点选、还没发出去的，换了项目还是它，换回来也还在；页上选的模型、强度、计划模式也一样。
// 二、项目的选择器最后一项是“添加项目…”：添加成了页上就指着新的那个，写了一半的字不动。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface HomeMoreProbe {
  harness: {
    /** 一开始的去处和 harness：“设备/项目/harness” */
    start: string
    /** 换到这台设备上还没建过会话的项目，默认的 harness */
    fresh: string
    /** 在那里换了一个 harness 建成会话之后，再到新建对话页：“设备/项目/harness” */
    after: string
    /** 换回原来那个项目、再换过来，各是哪个 harness */
    back: string
    again: string
    /** 没发出去只是点选的：换到别的项目是哪个，再换回来是哪个 */
    pickedCarried: string
    pickedKept: string
    /** 页上选了模型、强度、开了计划模式再换项目：“模型/强度/计划模式开没开” */
    settingsCarried: string
  }
  add: {
    /** 选择器里最后两项写的什么，最后那一项是不是标成了“一件事” */
    before: string
    last: string
    marked: boolean
    /** 点了它出对话框；取消之后页上指的没变 */
    dialog: boolean
    cancelKept: boolean
    /** 填了目录点添加之后页上指着哪（“设备/项目”），标题栏上的项目，输入框里写了一半的字还在不在 */
    picked: string
    crumb: string
    draftKept: boolean
    /** 选择器里现在列的项目（不算最后那一项） */
    listed: string
    /** 没连着的设备上有没有这一项 */
    offlineHas: boolean
  }
}

export async function homeMoreProbe(): Promise<HomeMoreProbe> {
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
    throw new Error(`新建对话页（后补的）：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement | HTMLInputElement, words: string) => {
    const kind = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(kind.prototype, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const home = () => one('.new-hero')
  const picker = (kind: string) => one<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)
  const options = (kind: string) => all(`.pick[data-kind="${kind}"] .pick-opt`)
  const shown = (kind: string) => text(picker(kind))
  const place = () => `${shown('device')}/${shown('workspace')}`
  const titleOf = (option: Element) => text(one('b', option))
  /** 点开一个选择器，等选项出来 */
  const unfold = async (kind: string) => {
    ;(await until(`“${kind}”的选择器`, () => picker(kind))).click()
    return until(`“${kind}”的选项`, () => (options(kind).length > 0 ? options(kind) : null))
  }
  const fold = async (kind: string) => {
    if (options(kind).length === 0) return
    picker(kind)?.click()
    await until(`“${kind}”的选择器收起`, () => options(kind).length === 0)
  }
  const choose = async (kind: string, title: string) => {
    if (shown(kind) === title) return
    const option = (await unfold(kind)).find((entry) => titleOf(entry) === title)
    if (!option) throw new Error(`新建对话页（后补的）：“${kind}”里没有“${title}”`)
    option.click()
    await until(`“${kind}”换成“${title}”`, () => shown(kind) === title)
    await frame()
  }
  const toHome = async () => {
    ;(await until('侧栏最上面的“新对话”', () => one<HTMLButtonElement>('.sb-link.new'))).click()
    await until('新建对话页', () => home() && picker('device') && area())
    await frame()
  }
  const rowOf = (title: string) => all('.ss-row').find((row) => text(row).includes(title))
  /** 一行（会话或者项目）行尾的“更多”里点“删除”，再确认 */
  const removeVia = async (line: Element | null | undefined, what: string) => {
    line?.querySelector<HTMLButtonElement>('.row-more > .ibtn')?.click()
    const remove = await until(`${what}菜单里的“删除”`, () =>
      all('.row-more .pick-opt').find((item) => text(item).includes('删除')),
    )
    remove.click()
    ;(
      await until(`删除${what}的确认`, () =>
        one<HTMLButtonElement>('.row-more .pick-ask .btn.danger'),
      )
    ).click()
  }

  // ---- 一、harness 按项目记 ----
  await toHome()
  await choose('device', 'build-01')
  const start = `${place()}/${shown('harness')}`
  await choose('workspace', 'litch')
  const fresh = shown('harness')
  await choose('harness', 'Claude Code')
  const second = '第二个项目里开的一句'
  const input = await until('输入框', area)
  write(input, second)
  await frame()
  press(input, 'Enter')
  await until('落到新会话里', () => !home() && text(one('.ss-row.sel')).includes(second))
  // 回话不用等它写完：停掉
  const stop = await until('停止按钮', () => one<HTMLButtonElement>('.send.stop'), 10_000).catch(
    () => null,
  )
  stop?.click()
  await until('这一轮结束', () => !running(), 60_000)
  await toHome()
  const after = `${place()}/${shown('harness')}`
  await choose('workspace', 'infra')
  const back = shown('harness')
  await choose('workspace', 'litch')
  const again = shown('harness')
  // 只是点选、没发出去
  await choose('harness', 'dsh')
  await choose('workspace', 'infra')
  const pickedCarried = shown('harness')
  await choose('workspace', 'litch')
  const pickedKept = shown('harness')
  await choose('harness', 'Claude Code')
  // 选了模型、强度，开了计划模式，再换项目：都还在。计划模式按提示语认开没开，不认具体的属性
  await choose('model', 'Opus 5.5')
  await choose('effort', '高')
  const plan = await until('计划模式的开关', () =>
    one<HTMLButtonElement>('.mode-btn[data-kind="plan"]'),
  )
  const planOff = plan.title
  plan.click()
  await until('计划模式开了', () => one('.mode-btn[data-kind="plan"]')?.title !== planOff)
  await choose('workspace', 'infra')
  await until('换到 infra', () => shown('workspace') === 'infra' && picker('model'))
  await frame()
  const planOn = one('.mode-btn[data-kind="plan"]')?.title
  const settingsCarried = `${shown('model')}/${shown('effort')}/${planOn !== undefined && planOn !== planOff ? '开' : '关'}`
  // 收拾：计划模式只管这一次，换回去之前关掉；模型、强度换回来没选过时的样子由下面建会话之前的新建页重新定
  one<HTMLButtonElement>('.mode-btn[data-kind="plan"]')?.click()
  await choose('workspace', 'litch')
  // 收拾：刚建的会话删掉（正开着它删，会回到新建对话页）
  const mine = await until('刚建的那个会话', () => rowOf(second))
  mine.click()
  await until('它的内容', () => all('.umsg-text').some((entry) => text(entry) === second))
  await removeVia(rowOf(second)?.parentElement, '会话')
  await until('删掉的那一行消失', () => !rowOf(second))
  await until('回到新建对话页', () => home() && area())

  // ---- 二、项目选择器里的“添加项目…” ----
  await toHome()
  await choose('device', '本机')
  const kept = place()
  const half = '写了一半的'
  write(await until('输入框', area), half)
  await frame()
  const dialog = () => one<HTMLDialogElement>('dialog.ws-dialog[open]')
  const openAdd = async () => {
    const found = await unfold('workspace')
    const last = found.at(-1)
    const seen = {
      before: found.at(-2) ? titleOf(found.at(-2) as Element) : '',
      last: last ? titleOf(last) : '',
      marked: last?.dataset.action !== undefined,
    }
    last?.click()
    return {
      ...seen,
      dialog: Boolean(await until('添加项目的对话框', dialog, 5000).catch(() => null)),
    }
  }
  const first = await openAdd()
  one<HTMLButtonElement>('.modal-foot .btn:not(.primary)', dialog() ?? document)?.click()
  await until('对话框关了', () => !dialog())
  await frame()
  const cancelKept = place() === kept
  await openAdd()
  const root = await until('目录那一栏', () => one<HTMLInputElement>('#ws-root'))
  write(root, '/Users/me/work/probe-space')
  const submit = await until('“添加”能点了', () => {
    const button = one<HTMLButtonElement>('.modal-foot .btn.primary', dialog() ?? document)
    return button && !button.disabled ? button : null
  })
  submit.click()
  await until('对话框关了', () => !dialog())
  await until('页上指着新的项目', () => shown('workspace') === 'probe-space', 5000).catch(
    () => null,
  )
  const picked = place()
  const crumb = text(one('.crumb span.ell'))
  const draftKept = area()?.value === half
  const listed = (await unfold('workspace'))
    .filter((option) => option.dataset.action === undefined)
    .map(titleOf)
    .join('|')
  await fold('workspace')
  // 没连着的设备上管不了项目：没有这一项
  await choose('device', 'gpu-box')
  const offlineHas = (await unfold('workspace')).some(
    (option) => option.dataset.action !== undefined,
  )
  await fold('workspace')
  // 收拾：新加的项目删掉，写了一半的字清掉
  await choose('device', '本机')
  const line = all('.row-line[data-workspace]').find(
    (entry) => text(one('.ws-row .name', entry)) === 'probe-space',
  )
  if (line) {
    await removeVia(line, '项目')
    await until('新加的项目没了', () =>
      all('.ws-row .name').every((entry) => text(entry) !== 'probe-space'),
    )
  }
  await toHome()
  const left = area()
  if (left?.value) write(left, '')
  await frame()

  return {
    harness: { start, fresh, after, back, again, pickedCarried, pickedKept, settingsCarried },
    add: { ...first, cancelKept, picked, crumb, draftKept, listed, offlineHas },
  }
}

export function judgeHomeMore(probe: HomeMoreProbe): string[] {
  const failed: string[] = []
  const { harness, add } = probe
  if (harness.start !== 'build-01/infra/Pi') {
    failed.push(`这一组开头的去处和 harness 不是上一组留下的：“${harness.start}”`)
  }
  if (harness.fresh !== 'Pi') {
    failed.push(`还没建过会话的项目，默认的 harness 该是这台设备最近用的 Pi：“${harness.fresh}”`)
  }
  if (harness.after !== 'build-01/litch/Claude Code') {
    failed.push(`在另一个项目里换了 harness 建成之后，默认值不是这一次用的：“${harness.after}”`)
  }
  if (harness.back !== 'Pi' || harness.again !== 'Claude Code') {
    failed.push(
      `harness 没有按项目各记各的：换回去是“${harness.back}”，再换过来是“${harness.again}”`,
    )
  }
  if (harness.pickedCarried !== 'dsh') {
    failed.push(`只是点选、没发出去的 harness，换了项目就没了：“${harness.pickedCarried}”`)
  }
  if (harness.pickedKept !== 'dsh') {
    failed.push(`只是点选、没发出去的 harness，换了项目再换回来没了：“${harness.pickedKept}”`)
  }
  if (harness.settingsCarried !== 'Opus 5.5/高/开') {
    failed.push(`页上选的模型、强度、计划模式，换了项目没留住：“${harness.settingsCarried}”`)
  }
  if (add.last !== '添加项目…' || !add.marked || add.before !== '无项目') {
    failed.push(`项目选择器的最后一项不是“添加项目…”：“${add.before}”“${add.last}”`)
  }
  if (!add.dialog) failed.push('点了“添加项目…”，没有出添加的对话框')
  if (!add.cancelKept) failed.push('添加项目点了取消，页上指的去处变了')
  if (add.picked !== '本机/probe-space' || add.crumb !== 'probe-space') {
    failed.push(`添加成了之后页上没有指着新的项目：“${add.picked}”，标题栏“${add.crumb}”`)
  }
  if (!add.draftKept) failed.push('添加项目之后，输入框里写了一半的字没了')
  if (add.listed !== 'litch|docs-site|probe-space|无项目') {
    failed.push(`添加之后项目选择器里列的不对：${add.listed}`)
  }
  if (add.offlineHas) failed.push('没连着的设备上，项目选择器里还有“添加项目…”')
  return failed
}
