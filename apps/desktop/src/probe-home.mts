// 新建对话页的验收：应用启动落在哪、页上能选什么、默认值怎么记、发出去建不建得成。
// 排在 probe-compose.mts 前面，在同一个窗口里跑（它要量的是“刚启动”的样子），client:check:compose 和它的 :entry 都包含它。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 对着模拟核心时多量几样只有那里才有的：四台设备之间换来换去、没连上的设备、建不成的会话（话里带“建不成”）；
// 样子（中英文、三种皮肤、最窄的窗口）在 probe-home-look.mts。

export interface HomeProbe {
  /** 启动之后主区域里的那句提示语。没落在新建对话页就是空的 */
  hero: string
  /** 没有哪个会话被自动选中，主区域里也没有对话内容 */
  nothingPicked: boolean
  /** 侧栏最上面的“新对话”标成了当前页 */
  entryCurrent: boolean
  /** 标题栏最后一段 */
  title: string
  /** 输入框一出现就拿着焦点：打开应用就能直接打字 */
  focused: boolean
  /** 默认的去处：“设备/工作区” */
  defaults: string
  /** 设备、工作区两个选择器里各列了什么 */
  devices: string[]
  workspaces: string[]
  /** 在页上换设备、换工作区、换 harness。只在模拟核心上量（隔离入口只有一台设备、一个 harness） */
  follow: {
    /** 各台设备上能选的：“工作区｜harness｜模型”。没有选 harness 的选择器（只有一个可用）记成“（没有）” */
    local: string
    build: string
    nas: string
    /** 换了设备，标题栏上的设备跟着换 */
    titleDevice: string
    /** 换了工作区：标题栏跟着换，侧栏里那个工作区行上的加号亮着 */
    titleWorkspace: string
    addLit: boolean
    /** 换了 harness：模型的清单跟着换（换之前、换之后） */
    modelsBefore: string
    modelsAfter: string
    /** 换来换去，输入框里写了一半的字没动 */
    draftKept: boolean
  } | null
  /** 选了一台没连上的设备。只在模拟核心上量 */
  offline: {
    /** 输入框下面那句话 */
    hint: string
    /** 后面跟着的原因 */
    reason: string
    /** 发送按钮停用了；按回车也发不出去，字还在 */
    sendOff: boolean
    stayed: boolean
    /** 有去“设备”一页的按钮，点了就到；从那一页回来，页上选的还是这台 */
    toDevices: boolean
    keptAcrossPage: boolean
  } | null
  /** 会话没建成（模拟核心里话里带“建不成”）。只在模拟核心上量 */
  failed: {
    hint: string
    /** 写的字还回了输入框，人还在新建对话页上 */
    textBack: boolean
    stayed: boolean
  } | null
  /** 写一句发出去 */
  created: {
    /** 按下回车到这句话出现在对话的位置上，隔了多久（毫秒） */
    bubbleMs: number
    /** 建好之后落在新会话里：标题栏是“设备/工作区/这句话” */
    crumb: string
    /** 侧栏里它那一行在哪台设备、哪个工作区下面，徽标是什么 */
    place: string
    chip: string
    /** 第一条回话有没有对上。只在真实入口上量 */
    echoed: boolean | null
  }
  /** 该建在哪：“设备/工作区” */
  wanted: string
  /** 再点“新对话”：默认的去处换成了刚才用的（“设备/工作区/harness”，没有选 harness 的选择器时最后一段是空的） */
  remembered: string
  /** 换到没在上面建过会话的设备是“无工作区”，换回来又是上次用的。只在模拟核心上量 */
  rememberedPerDevice: string | null
  /** 工作区行上的加号：带着那个设备和工作区落到这一页（看到的、该是的） */
  rowAdd: string
  rowAddWanted: string
  /** 没有眼前的会话（开着设备页）时按 Ctrl+N：到这一页，用默认的去处 */
  shortcutBare: string
  /** 开着一个会话时按 Ctrl+N：到这一页，去处是那个会话所在的设备和工作区（看到的、该是的） */
  shortcutFrom: string
  shortcutFromWanted: string
  /** 把刚建的会话删掉（当时正开着它）：回到新建对话页，不是落到别的会话里 */
  deletedHome: boolean
}

export async function homeProbe(real: boolean): Promise<HomeProbe> {
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
    throw new Error(`新建对话页：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const users = () => all('.umsg-text').map(text)
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  const home = () => one('.new-hero')
  /** 页上的一个选择器：device、workspace、harness、model、permission */
  const picker = (kind: string) => one<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)
  const options = (kind: string) => all(`.pick[data-kind="${kind}"] .pick-opt`)
  const shown = (kind: string) => text(picker(kind))
  const place = () => `${shown('device')}/${shown('workspace')}`
  /** 点开一个选择器看它列了哪些，再收起来 */
  const listed = async (kind: string) => {
    const button = await until(`“${kind}”的选择器`, () => picker(kind))
    button.click()
    const found = await until(`“${kind}”的选项`, () =>
      options(kind).length > 0 ? options(kind) : null,
    )
    // 最后那项“添加工作区…”不是一个值，不算在列的东西里（它自己在 probe-home-more.mts 里量）
    const titles = found
      .filter((option) => option.dataset.action === undefined)
      .map((option) => text(one('b', option)))
    button.click()
    await until(`“${kind}”的选择器收起`, () => options(kind).length === 0)
    return titles
  }
  /** 点开一个选择器，选标题是这几个字的那一项 */
  const choose = async (kind: string, title: string) => {
    if (shown(kind) === title) return
    ;(await until(`“${kind}”的选择器`, () => picker(kind))).click()
    const option = await until(`“${kind}”里的“${title}”`, () =>
      options(kind).find((entry) => text(one('b', entry)) === title),
    )
    option.click()
    await until(`“${kind}”换成“${title}”`, () => shown(kind) === title)
    await frame()
  }
  const rowOf = (title: string) => all('.ss-row').find((row) => text(row).includes(title))
  /** 侧栏里一行会话在哪：“设备/工作区”。不属于任何工作区的那一组，名字就是它上面那个小标题 */
  const placeOf = (row: Element | undefined) => {
    const group = row?.closest('[data-group]')
    const device = text(one('.dev-row .name', row?.closest('.dev-group') ?? document))
    return `${device}/${text(one('.ws-row .name, .sec-label', group ?? document))}`
  }

  // ---- 一、启动落在新建对话页 ----
  await until('侧栏里的会话', () => one('.ss-row'))
  await until('新建对话页的提示语和输入框', () => home() && area())
  // 等一会儿再看：要是还会自动选中哪个会话，这时也该选上了
  await sleep(600)
  const hero = text(home())
  const nothingPicked = !one('.ss-row.sel') && !one('.turn')
  const entryCurrent = one('.sb-link.new')?.getAttribute('aria-current') === 'page'
  const title = text(one('.crumb b'))
  const focused = document.activeElement === area()
  const defaults = place()
  const devices = await listed('device')
  const workspaces = await listed('workspace')

  // ---- 二、在页上换设备、换工作区、换 harness：各个选择器里能选的跟着换 ----
  let follow: HomeProbe['follow'] = null
  let offline: HomeProbe['offline'] = null
  let failed: HomeProbe['failed'] = null
  if (!real) {
    /** 现在这台设备上能选的：“工作区｜harness｜模型” */
    const offered = async () => {
      // 模型的清单是换了设备之后现问的：等它的选择器出来
      const models = await until('模型的选择器', () => picker('model'), 5000).catch(() => null)
      return [
        (await listed('workspace')).join('|'),
        picker('harness') ? (await listed('harness')).join('|') : '（没有）',
        models ? (await listed('model')).join('|') : '（没有）',
      ].join('｜')
    }
    const half = '写了一半的'
    write(await until('输入框', area), half)
    await frame()
    const local = await offered()
    await choose('device', 'build-01')
    const titleDevice = text(one('.crumb .dev'))
    const build = await offered()
    await choose('device', 'nas')
    const nas = await offered()

    await choose('device', '本机')
    await choose('workspace', 'docs-site')
    const titleWorkspace = text(one('.crumb span.ell'))
    const addLit = Boolean(
      all('.row-add.on').find((button) => text(button.parentElement).includes('docs-site')),
    )
    const modelsBefore = (await listed('model')).join('|')
    await choose('harness', 'Pi')
    // 另一个 harness 的清单是现问的：选择器先没了再出来，等它出来再看
    let modelsAfter = modelsBefore
    for (let tries = 0; tries < 60 && modelsAfter === modelsBefore; tries++) {
      await sleep(50)
      if (picker('model')) modelsAfter = (await listed('model')).join('|')
    }
    // 换回来：后面的验收在本机上新建会话，用的是排第一个的 harness
    await choose('harness', 'Claude Code')
    await choose('workspace', '无工作区')
    follow = {
      local,
      build,
      nas,
      titleDevice,
      titleWorkspace,
      addLit,
      modelsBefore,
      modelsAfter,
      draftKept: area()?.value === half,
    }

    // ---- 三、选了一台没连上的设备：发不出去，当场说为什么、下一步去哪 ----
    await choose('device', 'gpu-box')
    const why = await until('没连上的说明', () => one('.new-why[data-down="device"]'), 5000).catch(
      () => null,
    )
    const hint = text(one('.dock .cmp-hint.err'))
    const reason = text(one('.cfail-text', why ?? document))
    const sendOff = one<HTMLButtonElement>('.dock .send')?.disabled === true
    const stuck = '发不出去的一句'
    const field = await until('输入框', area)
    write(field, stuck)
    await frame()
    press(field, 'Enter')
    await sleep(300)
    const stayed = area()?.value === stuck && Boolean(home()) && users().length === 0
    one<HTMLButtonElement>('[data-act="open-devices"]', why ?? document)?.click()
    const toDevices = Boolean(await until('“设备”一页', () => one('.devp'), 5000).catch(() => null))
    one<HTMLButtonElement>('.devp .arch-head .ibtn')?.click()
    await until('回到新建对话页', () => home() && picker('device'), 5000).catch(() => null)
    offline = {
      hint,
      reason,
      sendOff,
      stayed,
      toDevices,
      keptAcrossPage: shown('device') === 'gpu-box',
    }

    // ---- 四、会话没建成：说明原因，写的字还回输入框 ----
    await choose('device', 'build-01')
    await choose('workspace', 'infra')
    const refused = '这一句建不成'
    const again = await until('输入框', area)
    write(again, refused)
    await frame()
    press(again, 'Enter')
    const failure = await until(
      '没建成的说明',
      () => {
        const line = text(one('.dock .cmp-hint.err'))
        return line.includes('会话没建成') ? line : null
      },
      10_000,
    ).catch(() => '')
    failed = {
      hint: failure,
      textBack: area()?.value === refused,
      stayed: Boolean(home()) && !one('.ss-row.sel') && place() === 'build-01/infra',
    }
  }

  // ---- 五、写一句发出去：这句话立刻出现，建好之后落在新会话里 ----
  // 模拟核心：建在另一台设备上、换一个 harness，好看出后面记住的是不是这一次用的。
  // 真实入口：只有本机一台，建在它的头一个工作区里
  if (real) {
    await choose('workspace', workspaces[0] ?? '无工作区')
  } else {
    await choose('device', 'build-01')
    await choose('workspace', 'infra')
    await choose('harness', 'Pi')
  }
  const wanted = place()
  const opening = '从新建对话页开的头一句'
  const fresh = await until('输入框', area)
  write(fresh, opening)
  await frame()
  const sentAt = performance.now()
  press(fresh, 'Enter')
  await until('第一条消息出现', () => users().includes(opening))
  const bubbleMs = performance.now() - sentAt
  await until('落到新会话里', () => !home() && text(one('.ss-row.sel')).includes(opening))
  await until('标题栏换成新会话', () => text(one('.crumb b')).includes(opening), 5000).catch(
    () => null,
  )
  const crumb = `${text(one('.crumb .dev'))}/${text(one('.crumb span.ell'))}/${text(one('.crumb b'))}`
  const created: HomeProbe['created'] = {
    bubbleMs,
    crumb,
    place: placeOf(one('.ss-row.sel') ?? undefined),
    chip: text(one('.crumb .chip')),
    echoed: null,
  }
  await until('新会话的回话结束', () => !running() && one('.turn-foot'), 60_000)
  if (real) created.echoed = text(one('.turn')).includes(`收到：${opening}`)

  // ---- 六、默认值记住了：再到这一页，去处是刚才用的 ----
  const entry = await until('侧栏最上面的“新对话”', () => one<HTMLButtonElement>('.sb-link.new'))
  entry.click()
  await until('回到新建对话页', () => home() && picker('device'))
  await frame()
  const remembered = `${place()}/${shown('harness')}`
  let rememberedPerDevice: string | null = null
  if (!real) {
    await choose('device', '本机')
    const elsewhere = place()
    await choose('device', 'build-01')
    rememberedPerDevice = `${elsewhere}→${place()}`
  }

  // ---- 七、工作区行上的加号：带着那个设备和工作区落到这一页 ----
  // 模拟核心点本机上另一个工作区的；真实入口点设备行上的（不属于任何工作区）。都和记住的默认值不一样
  const rowAddWanted = real ? '本机/无工作区' : '本机/docs-site'
  const add = real
    ? one<HTMLButtonElement>('.row-add', one('.dev-row')?.parentElement ?? document)
    : all('.row-add').find((button) => text(button.parentElement).includes('docs-site'))
  add?.click()
  await until('加号带来的去处', () => home() && place() === rowAddWanted, 5000).catch(() => null)
  const rowAdd = home() ? place() : ''

  // ---- 八、Ctrl+N ----
  // 眼前没有会话（开着“设备”一页，之前也没选着哪个会话）：到新建对话页，用默认的去处
  one<HTMLButtonElement>('.sb-link.devices')?.click()
  await until('“设备”一页', () => one('.devp'))
  press(document, 'n', { ctrlKey: true })
  await until('快捷键带到新建对话页', () => home() && picker('device'), 5000).catch(() => null)
  await frame()
  const shortcutBare = home() ? place() : ''
  // 开着一个会话：去处是它所在的设备和工作区。挑一个和默认值不在一处的
  const shortcutFromWanted = real ? '本机/无工作区' : '本机/docs-site'
  const from = real ? one('.ss-row', one('[data-group=""]') ?? document) : rowOf('首页文案')
  from?.click()
  await until('点开的会话', () => from?.classList.contains('sel') && !home(), 10_000).catch(
    () => null,
  )
  press(document, 'n', { ctrlKey: true })
  await until('快捷键带到新建对话页', () => home() && picker('device'), 5000).catch(() => null)
  await frame()
  const shortcutFrom = home() ? place() : ''

  // ---- 九、把刚建的会话删掉（当时正开着它）：回到新建对话页 ----
  const mine = await until('刚建的那个会话', () => rowOf(opening))
  mine.click()
  await until('它的内容', () => users().includes(opening))
  rowOf(opening)?.parentElement?.querySelector<HTMLButtonElement>('.row-more > .ibtn')?.click()
  const remove = await until('菜单里的“删除”', () =>
    all('.row-more .pick-opt').find((item) => text(item).includes('删除')),
  )
  remove.click()
  const yes = await until('删除的确认', () =>
    one<HTMLButtonElement>('.row-more .pick-ask .btn.danger'),
  )
  yes.click()
  await until('删掉的那一行消失', () => !rowOf(opening))
  const deletedHome = Boolean(
    await until('回到新建对话页', () => home() && !one('.ss-row.sel') && !one('.turn'), 5000).catch(
      () => null,
    ),
  )
  // 不给后面的验收留东西：输入框是空的
  const left = area()
  if (left?.value) write(left, '')
  await frame()

  return {
    hero,
    nothingPicked,
    entryCurrent,
    title,
    focused,
    defaults,
    devices,
    workspaces,
    follow,
    offline,
    failed,
    created,
    wanted,
    remembered,
    rememberedPerDevice,
    rowAdd,
    rowAddWanted,
    shortcutBare,
    shortcutFrom,
    shortcutFromWanted,
    deletedHome,
  }
}

export function judgeHome(probe: HomeProbe, real: boolean): string[] {
  const failed: string[] = []
  // ---- 启动落在哪 ----
  if (probe.hero !== '今天要施展什么魔法') {
    failed.push(`启动之后主区域里不是那句提示语：“${probe.hero}”`)
  }
  if (!probe.nothingPicked) failed.push('启动之后自动选中了一个会话，或者主区域里有对话内容')
  if (!probe.entryCurrent) failed.push('在新建对话页上，侧栏最上面的“新对话”没有标成当前页')
  if (probe.title !== '新对话') failed.push(`新建对话页的标题栏不对：“${probe.title}”`)
  if (!probe.focused) failed.push('新建对话页的输入框没有拿到焦点')
  if (probe.defaults !== '本机/无工作区') {
    failed.push(`头一次打开，默认的去处该是本机、不属于任何工作区：“${probe.defaults}”`)
  }
  const devices = probe.devices.join('|')
  if (real ? devices !== '本机' : devices !== '本机|build-01|nas|gpu-box') {
    failed.push(`选设备的选择器里列的不对：${devices}`)
  }
  const workspaces = probe.workspaces.join('|')
  if (real ? probe.workspaces.at(-1) !== '无工作区' : workspaces !== 'litch|docs-site|无工作区') {
    failed.push(`选工作区的选择器里列的不对：${workspaces}`)
  }

  // ---- 换设备、换工作区、换 harness ----
  const { follow } = probe
  if (follow) {
    const [localSpaces = '', localHarness = '', localModels = ''] = follow.local.split('｜')
    const [buildSpaces = '', buildHarness = '', buildModels = ''] = follow.build.split('｜')
    const [nasSpaces = '', nasHarness = '', nasModels = ''] = follow.nas.split('｜')
    if (
      localSpaces !== 'litch|docs-site|无工作区' ||
      buildSpaces !== 'litch|infra|无工作区' ||
      nasSpaces !== 'backup-scripts|无工作区'
    ) {
      failed.push(`换了设备，工作区的清单没有跟着换：${localSpaces}；${buildSpaces}；${nasSpaces}`)
    }
    // 本机上的 Codex 没装：列着，选不了；另一台上四个都能选；第三台只有一个，不出选择器
    if (
      localHarness !== 'Claude Code|Pi|dsh|Codex' ||
      buildHarness !== 'Claude Code|Pi|dsh|Codex' ||
      nasHarness !== '（没有）'
    ) {
      failed.push(
        `换了设备，harness 的选择器没有跟着换：${localHarness}；${buildHarness}；${nasHarness}`,
      )
    }
    if (!localModels || localModels === '（没有）' || !buildModels || buildModels === '（没有）') {
      failed.push(`新建对话页上没有模型的选择器：${localModels}；${buildModels}`)
    }
    // 第三台上是另一个 harness，模型是它自己的那一份
    if (!nasModels || nasModels === '（没有）' || nasModels === localModels) {
      failed.push(`换到只有另一个 harness 的设备，模型的清单没有跟着换：${nasModels}`)
    }
    if (follow.titleDevice !== 'build-01') {
      failed.push(`在页上换了设备，标题栏没有跟着换：“${follow.titleDevice}”`)
    }
    if (follow.titleWorkspace !== 'docs-site') {
      failed.push(`在页上换了工作区，标题栏没有跟着换：“${follow.titleWorkspace}”`)
    }
    if (!follow.addLit) failed.push('在页上换了工作区，侧栏里那个工作区行上的加号没有亮')
    if (!follow.modelsAfter || follow.modelsAfter === follow.modelsBefore) {
      failed.push(
        `换了 harness，模型的清单没有跟着换：${follow.modelsBefore} → ${follow.modelsAfter}`,
      )
    }
    if (!follow.draftKept) failed.push('在页上换设备、换工作区，输入框里写了一半的字没了')
  }

  // ---- 没连上的设备 ----
  const { offline } = probe
  if (offline) {
    if (!offline.hint.includes('gpu-box')) {
      failed.push(`选了没连上的设备，输入框下面没有说是哪台、怎么了：“${offline.hint}”`)
    }
    if (!offline.reason) failed.push('选了没连上的设备，没有写没连上的原因')
    if (!offline.sendOff) failed.push('选了没连上的设备，发送按钮还能点')
    if (!offline.stayed) failed.push('选了没连上的设备，按回车把字发出去了或者弄丢了')
    if (!offline.toDevices) failed.push('选了没连上的设备，没有去“设备”一页的按钮，或者点了没到')
    if (!offline.keptAcrossPage) failed.push('从“设备”一页回来，新建对话页上选的设备变了')
  }

  // ---- 没建成 ----
  const { failed: refused } = probe
  if (refused) {
    if (!refused.hint.includes('建不成')) {
      failed.push(`会话没建成，没有说原因：“${refused.hint}”`)
    }
    if (!refused.textBack) failed.push('会话没建成，写的字没有还回输入框')
    if (!refused.stayed) failed.push('会话没建成，人没有留在新建对话页上，或者页上选的去处变了')
  }

  // ---- 建成了 ----
  const { created } = probe
  // 那句话是界面自己先画的，不等会话建好；真实入口上建一个会话要一两秒
  if (created.bubbleMs >= 300) {
    failed.push(`新建对话页上发出去的话 ${Math.round(created.bubbleMs)} 毫秒才出现`)
  }
  const opening = '从新建对话页开的头一句'
  if (!created.crumb.startsWith(`${probe.wanted}/`) || !created.crumb.endsWith(opening)) {
    failed.push(`建好之后标题栏不对：“${created.crumb}”，该是“${probe.wanted}/${opening}”`)
  }
  if (created.place !== probe.wanted) {
    failed.push(`新会话在侧栏里的位置不对：“${created.place}”，该在“${probe.wanted}”`)
  }
  if (real ? !created.chip : created.chip !== 'PI') {
    failed.push(`新会话的徽标不对：“${created.chip}”`)
  }
  if (created.echoed === false) failed.push('新建对话页上建的会话，第一条回话没有对上')
  if (!real && probe.wanted !== 'build-01/infra') {
    failed.push(`没能在页上选到要建的地方：“${probe.wanted}”`)
  }

  // ---- 记住的默认值 ----
  const remembered = real ? `${probe.wanted}/` : `${probe.wanted}/Pi`
  if (probe.remembered !== remembered) {
    failed.push(
      `再到新建对话页，默认的去处不是刚才用的：“${probe.remembered}”，该是“${remembered}”`,
    )
  }
  if (
    probe.rememberedPerDevice !== null &&
    probe.rememberedPerDevice !== '本机/无工作区→build-01/infra'
  ) {
    failed.push(`各台设备上次用的工作区没有各记各的：“${probe.rememberedPerDevice}”`)
  }

  // ---- 入口 ----
  if (probe.rowAdd !== probe.rowAddWanted) {
    failed.push(`行上的加号带来的去处不对：“${probe.rowAdd}”，该是“${probe.rowAddWanted}”`)
  }
  if (probe.shortcutBare !== probe.wanted) {
    failed.push(
      `眼前没有会话时按 Ctrl+N，该到新建对话页、用默认的去处“${probe.wanted}”：“${probe.shortcutBare}”`,
    )
  }
  if (probe.shortcutFrom !== probe.shortcutFromWanted) {
    failed.push(
      `开着一个会话时按 Ctrl+N，去处该是它所在的“${probe.shortcutFromWanted}”：“${probe.shortcutFrom}”`,
    )
  }
  if (!probe.deletedHome) failed.push('正开着的会话删掉之后没有回到新建对话页')
  return failed
}
