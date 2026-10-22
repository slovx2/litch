// 远程设备的验收：在真的外壳里，对着假的远程机器（scripts/client-ssh-fixture.mjs）把添加、连接、
// 断线重连、分阶段的失败、改名换色、改连接、重新连接、移除走一遍。设备列表的一行上没有按钮：
// 对一台设备做的事都在点进去的详情里。和别的验收一样，下面的函数会被原样送进页面里执行，
// 不能引用函数外面的东西。
// 断线是真的断：页面打一行 LITCH_SIGNAL drop，起自检的脚本看到后把那条 ssh 杀掉。

export interface RemoteProbe {
  /**
   * 启动落在新建对话页，这时只有本机而它连不上：输入区下面说了为什么建不了（这里记下那句话），
   * 给了去“设备”一页的按钮，点了就到
   */
  homeBlocked: string
  /** 添加设备的对话框里列出了 ssh 配置里的主机 */
  discovered: boolean
  /** 勾上之后自己去看了一眼：能连的报出对面只有 codex 和它的版本，什么都没装的报“什么都没装” */
  checked: boolean
  /** 对话框的两种方式、设备页里，都没有密码输入框 */
  noPasswordField: boolean
  /** 加完之后设备出现在侧栏里，连上了，列出了会话 */
  connected: boolean
  rows: number
  /** 连接途中侧栏上显示过的说明（走到哪一步） */
  notes: string[]
  /** 本机没有指定入口、连不上，不耽误远程设备 */
  localDown: boolean
  /**
   * 远程设备连上之后回到新建对话页：默认指着的还是连不上的本机；在页上把设备换成远程的那台，
   * 说明收起、标题栏跟着换（这里记下换之后页上还留着的说明，该是空的）
   */
  homeDevices: string[]
  homeSwitched: string
  /** 点开一个会话看到了内容，发一句，回话带着这一句 */
  opened: boolean
  echoed: boolean
  /** 回合进行中把 ssh 断掉：设备显示成没连着，随后不用人管自己连回来 */
  dropped: boolean
  recovered: boolean
  /** 连回来之后，断线时正在进行的那个回合的回话完整到了界面上，没有手动刷新 */
  turnSurvived: boolean
  /** 之后还能接着发 */
  sentAfter: boolean
  /** 什么都没装的那台：侧栏里是原因和安装指引（装设备服务、只装 codex 两条路），没有 ssh 的报错 */
  guideShown: boolean
  guide: string
  /** 设备列表上那两台各说了对面是哪一种：连上的那台“只有它”，什么都没装的那台照实说 */
  listPeers: string
  /** 设备列表上这台设备的那一行里没有按钮和输入框：能做的事都在点进去的详情里 */
  rowIsPlain: boolean
  /** 详情里有连接方式和主机：说了是经 ssh、按哪个别名 */
  facts: string
  factsNamed: boolean
  /** 改名、换线色：侧栏、详情和设备列表一起变 */
  renamed: boolean
  recolored: boolean
  /** 改连接：对话框里带着现在的配置，没有密码框；换成已经加过的那台被拒绝，原因写在对话框里 */
  editPrefilled: string
  editMatches: boolean
  editRejected: string
  /** 换成版本太低的那台：照新的配置重新去连，停在“版本太低”上，详情里有原因和升级的指引 */
  moved: boolean
  movedGuide: string
  /** 详情里的“重新连接”：点了真的又去连了一次（状态离开过“连接失败”），再停回同一个原因上 */
  retried: string[]
  /** 移除先问一句；确认之后回到设备列表，从列表和侧栏里都消失 */
  removeAsked: boolean
  removed: boolean
  backOnList: boolean
}

export async function remoteProbe(aliases: {
  ok: string
  bare: string
  old: string
}): Promise<RemoteProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 60_000,
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
  const write = (target: HTMLTextAreaElement | HTMLInputElement, text: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: Element, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  /** 侧栏里的一台设备 */
  const group = (name: string) =>
    all('.dev-group').find((element) => one('.dev-row .name', element)?.textContent === name)
  /** 设备列表里的一台设备 */
  const item = (name: string) =>
    all('.devp-item').find((element) => one('.devp-name', element)?.textContent === name)
  /** 正开着的那台设备的详情。每次现找：设备照新配置重来的时候这一页会重画 */
  const detail = () => one('[data-detail]')
  const act = (name: string) => one<HTMLButtonElement>(`[data-act="${name}"]`, detail() ?? document)
  const online = (name: string) => {
    const element = group(name)
    return Boolean(element && !element.classList.contains('off'))
  }
  const noPassword = () => !one('input[type="password"]')

  // ---- 一、设备页，添加设备：从 ssh 配置里发现、勾上就检查 ----
  await until('侧栏底部的齿轮', () => one<HTMLButtonElement>('.sb-settings'))
  // 启动落在新建对话页。这时只有本机，而它连不上：输入区下面说了为什么建不了，按钮是去“设备”一页
  await until('新建对话页', () => one('.new-hero'))
  const toDevices = await until('说明里去“设备”一页的按钮', () =>
    one<HTMLButtonElement>('.new-why[data-down="device"] [data-act="open-devices"]'),
  )
  const homeBlocked = one('.dock .cmp-hint.err')?.textContent ?? ''
  toDevices.click()
  await until('设备页', () => one('.devp'))
  // 本机这一版要靠环境变量指定入口，自检没给：它该是连不上的
  const localDown = Boolean(all('.devp-item')[0]?.querySelector('.pill.err'))
  let noPasswordField = noPassword()
  ;(await until('“添加设备”', () => one<HTMLButtonElement>('.devp-add'))).click()
  await until('对话框', () => one('dialog.modal[open]'))
  const hostRow = (alias: string) =>
    all('.modal .host').find((row) => one('.nm', row)?.textContent === alias)
  await until('ssh 配置里的主机', () => hostRow(aliases.ok) && hostRow(aliases.bare))
  const discovered = true
  for (const alias of [aliases.ok, aliases.bare]) {
    one<HTMLInputElement>('input', hostRow(alias) as HTMLElement)?.click()
  }
  await until('两台都看过了', () =>
    [aliases.ok, aliases.bare].every((alias) => {
      const pill = one('.pill', hostRow(alias) as HTMLElement)
      return pill && (pill.classList.contains('ok') || pill.classList.contains('err'))
    }),
  )
  const checked =
    /Codex \d+\.\d+\.\d+/.test(
      one('.pill.ok', hostRow(aliases.ok) as HTMLElement)?.textContent ?? '',
    ) && Boolean(one('.pill.err', hostRow(aliases.bare) as HTMLElement))
  noPasswordField &&= noPassword()
  // 手动填写那一面也看一眼有没有密码框，再回来
  all('.modal .seg button')[1]?.click()
  await until('手动填写的那几栏', () => one('#add-host'))
  noPasswordField &&= noPassword()
  all('.modal .seg button')[0]?.click()
  await until('回到主机列表', () => hostRow(aliases.ok))

  // ---- 二、加进来，连上，列出会话 ----
  one<HTMLButtonElement>('.modal button[type="submit"]')?.click()
  await until('对话框关上', () => !one('dialog.modal[open]'))
  const notes: string[] = []
  await until('远程设备连上并列出会话', () => {
    const element = group(aliases.ok)
    const note = element && one('.dev-note', element)?.textContent
    if (note && notes[notes.length - 1] !== note) notes.push(note)
    return online(aliases.ok) && all('.ss-row', element).length > 0
  })
  const connected = true
  const remote = group(aliases.ok) as HTMLElement
  const rows = all('.ss-row', remote).length

  // ---- 三、什么都没装的那台：原因和安装指引 ----
  const bare = await until('什么都没装的那台停在失败上', () => {
    const element = group(aliases.bare)
    return element && one('.cfail', element) ? element : null
  })
  const guide = one('.cfail', bare)?.textContent ?? ''
  const commands = all('.cfail-cmd code', bare).map((code) => code.textContent ?? '')
  const guideShown =
    Boolean(one('.pill.err', bare)) &&
    // 两条路都给了：装设备服务的那一句，和只装 codex 的那一句
    commands.some((command) => command.includes('install.sh')) &&
    commands.some((command) => command.includes('@openai/codex')) &&
    // 是给人看的话，不是 ssh 或 shell 的原话
    !/Permission denied|command not found|exit|ssh:/i.test(guide)

  // ---- 四、打开会话，发一句 ----
  // 先关掉设备页，回到新建对话页：默认指着的还是本机（连不上）。在页上把设备换成刚连上的那台
  one<HTMLButtonElement>('.devp .arch-head .ibtn')?.click()
  await until('回到新建对话页', () => one('.new-hero') && one('.new-why[data-down="device"]'))
  const devicePicker = () => one<HTMLButtonElement>('.pick[data-kind="device"] .pick-btn')
  devicePicker()?.click()
  const choices = await until('设备选择器里的几台设备', () => {
    const found = all('.pick[data-kind="device"] .pick-opt')
    return found.length > 0 ? found : null
  })
  const homeDevices = choices.map((choice) => one('b', choice)?.textContent ?? '')
  choices.find((choice) => one('b', choice)?.textContent === aliases.ok)?.click()
  await until(
    '页上换成了远程的那台',
    () =>
      devicePicker()?.textContent === aliases.ok && one('.crumb .dev')?.textContent === aliases.ok,
  )
  await frame()
  const homeSwitched = `${one('.new-why')?.textContent ?? ''}${one('.dock .cmp-hint.err')?.textContent ?? ''}`
  all('.ss-row', remote)[0]?.click()
  await until('会话的内容', () => one('.turn'))
  const opened = true
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const say = async (text: string) => {
    const input = await until('输入框', area)
    write(input, text)
    await frame()
    press(input, 'Enter')
    await frame()
  }
  const lastTurn = () => all('.turn').at(-1)?.textContent ?? ''
  const running = () => Boolean(one('.running-line'))
  const settled = (text: string) => lastTurn().includes(`收到：${text}`) && !running()
  await say('远程的第一句')
  await until('第一句的回话', () => settled('远程的第一句'))
  const echoed = true

  // ---- 五、回合进行中断线：自己连回来，回合不丢 ----
  await say('断线的时候在说的这一句')
  await until('回话开始输出', () => (one('.md.live')?.textContent?.length ?? 0) > 0)
  console.log('LITCH_SIGNAL drop')
  await until('设备显示成没连着', () => !online(aliases.ok), 30_000)
  const dropped = true
  await until('自己连回来', () => online(aliases.ok))
  const recovered = true
  // 假模型把话分成几段慢慢发，最后一段的末尾是固定的。等到整段都在、回合结束
  await until('断线时那个回合的回话完整到达', () => {
    const text = lastTurn()
    return (
      text.includes('收到：断线的时候在说的这一句') && text.includes('一点一点出来的') && !running()
    )
  })
  const turnSurvived = true
  await say('连回来之后的一句')
  await until('连回来之后的回话', () => settled('连回来之后的一句'))
  const sentAfter = true

  // ---- 六、设备页：列表的一行上没有按钮，点进详情改名、换线色 ----
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进设备页的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="devices"]'),
    )
  ).click()
  await until('设备页', () => one('.devp'))
  noPasswordField &&= noPassword()
  const mine = await until('设备列表里的这台设备', () => item(aliases.ok))
  const peerOf = (name: string) => {
    const cell = one('.devp-has[data-peer]', item(name) ?? document.createElement('i'))
    return `${cell?.dataset.peer ?? ''}:${cell?.textContent?.trim() ?? ''}`
  }
  const listPeers = `${peerOf(aliases.ok)}｜${peerOf(aliases.bare)}`
  const rowIsPlain =
    all('button', mine).length === 1 && all('input, select, textarea, a', mine).length === 0
  one<HTMLButtonElement>('.devp-row', mine)?.click()
  await until('这台设备的详情', detail)
  noPasswordField &&= noPassword()
  const facts = all('.devp-facts dd', detail() as HTMLElement)
    .map((entry) => entry.textContent?.trim() ?? '')
    .join('｜')
  const factsNamed = facts.includes('ssh') && facts.includes(aliases.ok)
  act('rename')?.click()
  const nameInput = await until('改名的输入框', () =>
    one<HTMLInputElement>('.devp-rename', detail() as HTMLElement),
  )
  write(nameInput, '构建机')
  await frame()
  press(nameInput, 'Enter')
  await until(
    '新名字',
    () =>
      one('[data-device-name]', detail() as HTMLElement)?.textContent === '构建机' &&
      group('构建机'),
  )
  const renamed = true
  const swatch = all('.wires button', detail() as HTMLElement).find(
    (element) => element.getAttribute('aria-checked') === 'false',
  )
  const wire = swatch?.style.getPropertyValue('--wire') ?? ''
  swatch?.click()
  await until(
    '新线色',
    () =>
      group('构建机')?.style.getPropertyValue('--wire') === wire &&
      detail()?.style.getPropertyValue('--wire') === wire,
  )
  const recolored = wire !== ''

  // ---- 七、改连接：对话框带着现在的配置；换一台就照新的重新连 ----
  act('edit')?.click()
  await until('改连接的对话框', () => one('dialog.modal[open]'))
  const hostInput = await until('主机那一栏', () => one<HTMLInputElement>('#add-host'))
  const editPrefilled = `${hostInput.value}｜${one<HTMLInputElement>('#add-name')?.value ?? ''}`
  const editMatches = editPrefilled === `${aliases.ok}｜构建机`
  noPasswordField &&= noPassword()
  const save = () => one<HTMLButtonElement>('.modal button[type="submit"]')?.click()
  // 换成已经加过的那一台：不让，原因写在对话框里，对话框不关
  write(hostInput, aliases.bare)
  await frame()
  save()
  const editRejected =
    (await until('被拒绝的原因', () => one('.modal .modal-note.err')))?.textContent ?? ''
  // 换成版本太低的那一台：原来那条连接不要了，照新的配置重新来
  write(one<HTMLInputElement>('#add-host') as HTMLInputElement, aliases.old)
  await frame()
  save()
  await until('对话框关上', () => !one('dialog.modal[open]'))
  const stuck = () => {
    const page = detail()
    return page && one('.mng-title .pill.err', page) && one('.cfail', page) ? page : null
  }
  const movedPage = await until('照新的配置去连，停在版本太低上', stuck)
  const movedGuide = one('.cfail-cmd code', movedPage)?.textContent ?? ''
  const moved =
    Boolean(one('.cfail', group('构建机') as HTMLElement)) &&
    all('.devp-facts dd', movedPage).some((entry) => entry.textContent?.includes(aliases.old))

  // ---- 八、重新连接：在详情里，点了真的再去连一次 ----
  const pill = () => one('.mng-title .pill', detail() as HTMLElement)?.className ?? ''
  const retried: string[] = [pill()]
  const watch = new MutationObserver(() => {
    const now = pill()
    if (now && retried[retried.length - 1] !== now) retried.push(now)
  })
  watch.observe(document.body, { subtree: true, childList: true, attributes: true })
  ;(await until('详情里的“重新连接”', () => act('reconnect'))).click()
  await until('又去连了一次，停回同一个原因上', () => retried.length >= 3 && stuck())
  watch.disconnect()

  // ---- 九、移除：先问一句，确认之后回到列表 ----
  act('remove')?.click()
  const removeAsked = Boolean(
    await until('移除前的确认', () => one('.devp-ask', detail() as HTMLElement)),
  )
  // 移除的那一刻就该是列表：详情没了而列表还没出来、中间空一下的也算没过
  let blank = false
  const gap = new MutationObserver(() => {
    if (!detail() && !one('.devp-list')) blank = true
  })
  gap.observe(document.body, { subtree: true, childList: true })
  // 确认那一排里的“移除”才是真的动手
  act('remove-yes')?.click()
  await until('这台设备消失', () => !detail() && !item('构建机') && !group('构建机'))
  const removed = true
  await until('回到设备列表', () => one('.devp-list') && item(aliases.bare), 5_000)
  gap.disconnect()
  const backOnList = !blank

  return {
    homeBlocked,
    discovered,
    checked,
    noPasswordField,
    connected,
    rows,
    notes,
    localDown,
    homeDevices,
    homeSwitched,
    opened,
    echoed,
    dropped,
    recovered,
    turnSurvived,
    sentAfter,
    guideShown,
    guide,
    listPeers,
    rowIsPlain,
    facts,
    factsNamed,
    renamed,
    recolored,
    editPrefilled,
    editMatches,
    editRejected,
    moved,
    movedGuide,
    retried,
    removeAsked,
    removed,
    backOnList,
  }
}

export function judgeRemote(probe: RemoteProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    probe.homeBlocked.includes('本机'),
    `本机连不上的时候，新建对话页上没有说是它没连上：${probe.homeBlocked}`,
  )
  must(probe.discovered, '添加设备的对话框里没有列出 ssh 配置里的主机')
  must(probe.checked, '勾上主机之后没有给出检查的结果')
  must(probe.noPasswordField, '出现了密码输入框')
  must(probe.connected && probe.rows >= 4, `远程设备没有列出会话（${probe.rows} 行）`)
  must(
    probe.notes.some((note) => /ssh|codex/i.test(note)),
    `连接途中没有显示走到哪一步：${JSON.stringify(probe.notes)}`,
  )
  must(probe.localDown, '本机没有入口，却没有显示连不上')
  must(
    probe.homeDevices.length === 3 && probe.homeDevices[0] === '本机',
    `新建对话页的设备选择器里不是本机加两台远程设备：${probe.homeDevices.join('、')}`,
  )
  must(
    probe.homeSwitched === '',
    `在新建对话页上换到连着的远程设备之后，还说建不了：${probe.homeSwitched}`,
  )
  must(probe.opened && probe.echoed, '在远程设备上发消息没有收到对应的回话')
  must(probe.dropped, '断掉 ssh 之后设备没有显示成没连着')
  must(probe.recovered, '断线之后没有自己连回来')
  must(probe.turnSurvived, '断线时正在进行的回合没有完整到达')
  must(probe.sentAfter, '连回来之后发不了消息')
  must(probe.guideShown, `什么都没装的那台没有给出安装指引：${probe.guide}`)
  must(
    /^codex:仅 .+｜none:未安装$/.test(probe.listPeers),
    `设备列表上没有说出对面是哪一种：${probe.listPeers}`,
  )
  must(probe.rowIsPlain, '设备列表的一行上出现了整行那个按钮之外的按钮或输入框')
  must(probe.factsNamed, `详情里没有连接方式和主机：${probe.facts}`)
  must(probe.renamed, '改名没有生效')
  must(probe.recolored, '换线色没有生效')
  must(probe.editMatches, `改连接的对话框里没有带着现在的配置：${probe.editPrefilled}`)
  must(probe.editRejected.includes('已添加'), `换成已经加过的设备没有被拒绝：${probe.editRejected}`)
  must(
    probe.moved && probe.movedGuide.includes('@openai/codex@latest'),
    `改连接之后没有照新的配置重新连，或者详情里没有该怎么办：${probe.movedGuide}`,
  )
  must(
    probe.retried.length >= 3 &&
      probe.retried[0]?.includes('err') === true &&
      probe.retried.some((state) => !state.includes('err')) &&
      probe.retried.at(-1)?.includes('err') === true,
    `详情里的“重新连接”没有真的再去连一次：${JSON.stringify(probe.retried)}`,
  )
  must(probe.removeAsked, '移除之前没有问一句')
  must(probe.removed, '移除之后设备还在')
  must(probe.backOnList, '移除之后没有回到设备列表')
  return failed
}
