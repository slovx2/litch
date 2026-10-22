// 设备详情里“设备服务”一节的验收：看得到在跑的是哪一版、哪来的、怎么起的；
// 本机旧而忙没换时的说明和“现在再试一次”；换上了新版的提示；另外几种没换成的各给了什么办法。
// 都接在设备管理那两段验收的后面、在同一个窗口里跑（smoke.mts 的 manage-mock 和 manage）：
// - mockServiceProbe 对着模拟核心。换版本的各种情形由对话里的关键字来演
//   （“服务旧而忙”“服务换了新版”“服务是前台的”“服务太旧”“服务没停成”“服务比应用新”，
//   见 packages/core/src/mock/sample-service.mts）。它要求开头本机没有在跑、在等人的会话——
//   前面管理那一段已经把 Claude Code 强行重启过，示例里它的两个回合都了结了。
// - serviceProbe 对着真的设备服务（scripts/device-fixture.mjs --managed），只读：
//   真的服务报的来历界面读得到、摆得出来。那里外壳没有管服务的生死，所以没有换版本的说明。
// 两个探针函数会被原样送进页面里执行，不能引用函数外面的东西；评判的函数在主进程里跑。

export interface MockServiceProbe {
  /** 开头本机在跑、在等人的会话有几个（应该没有，见文件开头） */
  engagedBefore: number
  /** 平时设备列表上哪几行有“服务旧了没换成”的记号 */
  flagsBefore: string[]
  /** 本机平时：这一节开没开:要说的是哪种:标题后面的版本:小标 */
  localHead: string
  /** 点开之后：版本｜应用自带｜来源是哪一种:来源｜是不是按需拉起的｜启动时间｜进程号 */
  localFacts: string
  /** 远程的设备服务：同样看得到，来源给路径，没有“应用自带”一行 */
  remoteHead: string
  remoteFacts: string
  /** 没有设备服务的、没连上的：没有这一节 */
  absent: string[]
  /** 旧而忙没换：列表行上的记号、这一节的样子、说明、逐条的原因、按钮上的字 */
  flagsBusy: string[]
  busyHead: string
  busyText: string
  busyReasons: string[]
  retryLabel: string
  /** 默认开着但合得上，合上之后不自己弹开（合上之后>再点开） */
  busyFolds: string
  /** 点了“现在再试一次”：按钮（不能再点:上面的字） */
  retrying: string
  /** 还有回合停着：提示、原因换成现在的、照旧没换 */
  stillToast: string
  stillReasons: string[]
  stillHead: string
  /** 回合了结之后再试：换上了。提示、这一节的样子、那句话、还有没有“再试一次”、列表行上的记号 */
  doneToast: string
  replacedHead: string
  replacedText: string
  replacedHasRetry: boolean
  flagsAfter: string[]
  /** 另外几种（关键字 → 这一节的样子｜给的命令｜命令行的原话），和那时列表行上的记号 */
  scenes: Record<string, string>
  sceneFlags: Record<string, string[]>
}

export async function mockServiceProbe(): Promise<MockServiceProbe> {
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

  /** 回到设备列表：在详情里就退出来，在对话里就点侧栏的“设备” */
  const openList = async () => {
    if (one('[data-detail]')) one<HTMLButtonElement>('[data-detail] [data-act="back"]')?.click()
    else if (!one('.devp-item')) {
      one<HTMLButtonElement>('.sb-settings')?.click()
      ;(
        await until('设置页上进设备页的入口', () =>
          one<HTMLButtonElement>('.set-go[data-page="devices"]'),
        )
      ).click()
    }
    await until('设备列表', () => !one('[data-detail]') && all('.devp-item').length >= 4)
  }
  /** 设备列表上哪几行有记号 */
  const flags = async () => {
    await openList()
    return all('.devp-item')
      .filter((item) => one('[data-flag="service"]', item))
      .map((item) => item.dataset.device ?? '')
  }
  const openDetail = async (deviceId: string) => {
    await openList()
    one<HTMLButtonElement>(`.devp-item[data-device="${deviceId}"] .devp-row`)?.click()
    await until(`${deviceId} 的详情`, () => one(`[data-detail="${deviceId}"]`))
  }
  const section = () => one('[data-detail] [data-sec="service"]')
  const head = () => {
    const found = section()
    if (!found) return '没有这一节'
    return [
      found.dataset.open,
      found.dataset.notice ?? '没有要说的',
      text(one('.mng-sum', found)),
      text(one('[data-service-pill]', found)),
    ].join(':')
  }
  const foldOf = () => one<HTMLButtonElement>('.fold', section() ?? document)
  const unfold = async () => {
    await until('“设备服务”一节', section)
    if (section()?.dataset.open !== 'true') foldOf()?.click()
    await until('这一节点开', () => one('[data-sec="service"] .mng-sec-body'))
  }
  const fact = (name: string) => one(`[data-sec="service"] [data-fact="${name}"]`)
  const facts = () =>
    [
      text(fact('version')),
      fact('bundled') ? text(fact('bundled')) : '没有这一行',
      `${fact('origin')?.dataset.origin}:${text(fact('origin'))}`,
      fact('launch')?.dataset.detached ?? '',
      text(fact('started')) ? '有启动时间' : '没有启动时间',
      /^\d+$/.test(text(fact('pid'))) ? '有进程号' : '没有进程号',
    ].join('｜')
  const note = (kind: string) => one(`[data-sec="service"] [data-service-note="${kind}"]`)
  const reasons = () =>
    all('[data-sec="service"] [data-busy]').map((entry) => `${entry.dataset.busy}=${text(entry)}`)
  const retryButton = () =>
    one<HTMLButtonElement>('[data-sec="service"] [data-act="service-retry"]')
  const toast = () => text(one('.toast[data-toast="service-retry"] .toast-text'))

  // 本机上一个闲着的 DeepSeek Harness 会话：后面的话都在它里面说
  const local = () => one('.dev-group') as HTMLElement
  const engaged = (entry: Element) => Boolean(one('.st.run, .st.wait, .pill.wait', entry))
  await until('侧栏里的会话', () => all('.ss-row', local()).length >= 4)
  const engagedBefore = all('.ss-row', local()).filter(engaged).length
  const mine = all('.ss-row', local()).find(
    (entry) =>
      text(one('.chip', entry)) === 'DS' && !entry.classList.contains('down') && !engaged(entry),
  )
  if (!mine) throw new Error('本机上没有闲着的 DeepSeek Harness 会话')
  const title = text(one('.title', mine))
  const openSession = async () => {
    all('.ss-row', local())
      .find((entry) => text(one('.title', entry)) === title)
      ?.click()
    await until('打开这个会话', () => text(one('.crumb b')) === title)
  }
  /** 在那个会话里说一句。不等回合结束 */
  const say = async (words: string) => {
    await openSession()
    const area = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    const before = all('.turn').length
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, words)
    area.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await until('这一句发出去', () => all('.turn').length > before)
  }
  const settled = () => until('这个回合结束', () => !one('.req') && !one('.running-line'))

  // ---- 一、平时：看得到版本，不打扰 ----
  const flagsBefore = await flags()
  await openDetail('local')
  await until('“设备服务”一节', section)
  const localHead = head()
  await unfold()
  const localFacts = facts()
  await openDetail('build')
  await until('“设备服务”一节', section)
  const remoteHead = head()
  await unfold()
  const remoteFacts = facts()
  const absent: string[] = []
  for (const id of ['nas', 'gpu']) {
    await openDetail(id)
    absent.push(`${id}:${head()}`)
  }

  // ---- 二、旧而忙，没换：话里带“审批”，这个回合会停下来等人，服务就一直不闲 ----
  await say('服务旧而忙，这一步要一次审批')
  await until('审批卡片', () => one('.req'))
  const flagsBusy = await flags()
  await openDetail('local')
  await until('没换成的说明', () => note('busy'))
  const busyHead = head()
  const busyText = text(note('busy'))
  const busyReasons = reasons()
  const retryLabel = text(retryButton())
  foldOf()?.click()
  await until('合上', () => section()?.dataset.open === 'false')
  await sleep(200)
  const folded = section()?.dataset.open
  foldOf()?.click()
  await until('再点开', () => note('busy'))
  const busyFolds = `${folded}>${section()?.dataset.open}`

  // ---- 三、现在再试一次：回合还停着，照旧没换，原因换成现在的 ----
  retryButton()?.click()
  await until('按钮变成“正在重新连接”', () => retryButton()?.disabled)
  const retrying = `${retryButton()?.disabled}:${text(retryButton())}`
  const stillToast = await until('“还不闲”的提示', toast)
  await until('按钮回来', () => retryButton()?.disabled === false)
  const stillReasons = reasons()
  const stillHead = head()

  // ---- 四、把那个回合了结，再试：这回闲着，换上了 ----
  await openSession()
  ;(
    await until('审批卡片上的“同意”', () =>
      one<HTMLButtonElement>('.req .req-actions .btn.primary'),
    )
  ).click()
  await settled()
  await openDetail('local')
  ;(await until('“现在再试一次”', retryButton)).click()
  await until('换上了', () => section()?.dataset.notice === 'replaced')
  const doneToast = await until('“换成了”的提示', () => {
    const now = toast()
    return now && now !== stillToast ? now : null
  })
  const replacedHead = head()
  const replacedText = text(note('replaced'))
  const replacedHasRetry = Boolean(retryButton())
  const flagsAfter = await flags()

  // ---- 五、另外几种：各是什么样、给了什么办法 ----
  const scenes: Record<string, string> = {}
  const sceneFlags: Record<string, string[]> = {}
  for (const words of ['服务是前台的', '服务太旧', '服务没停成', '服务比应用新']) {
    await say(`演一出：${words}`)
    await settled()
    sceneFlags[words] = await flags()
    await openDetail('local')
    await until('“设备服务”一节', section)
    const shown = head()
    await unfold()
    const box = one('[data-sec="service"] .svc-note')
    scenes[words] = [
      shown,
      box ? all('.cfail-cmd code', box).map(text).join(' && ') : '',
      box ? text(one('.cfail-detail', box)) : '',
    ].join('｜')
  }
  await openList()

  return {
    engagedBefore,
    flagsBefore,
    localHead,
    localFacts,
    remoteHead,
    remoteFacts,
    absent,
    flagsBusy,
    busyHead,
    busyText,
    busyReasons,
    retryLabel,
    busyFolds,
    retrying,
    stillToast,
    stillReasons,
    stillHead,
    doneToast,
    replacedHead,
    replacedText,
    replacedHasRetry,
    flagsAfter,
    scenes,
    sceneFlags,
  }
}

export interface ServiceProbe {
  /** 本机的“设备服务”一节：开没开:要说的是哪种:标题后面的版本:小标 */
  head: string
  /** 点开之后：版本｜应用自带｜来源是哪一种:来源｜是不是按需拉起的｜启动时间｜进程号 */
  facts: string
  /** 换版本的说明有几块（这里外壳没有管服务的生死，应该没有） */
  notes: number
  /** 设备列表上本机那一行有没有记号 */
  flagged: boolean
}

export async function serviceProbe(): Promise<ServiceProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
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
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''

  // 从设备列表重新进一次本机的详情：这一节平时是收着的，要看它刚打开时的样子
  if (one('[data-detail]')) one<HTMLButtonElement>('[data-detail] [data-act="back"]')?.click()
  else if (!one('.devp-item')) {
    one<HTMLButtonElement>('.sb-settings')?.click()
    ;(
      await until('设置页上进设备页的入口', () =>
        one<HTMLButtonElement>('.set-go[data-page="devices"]'),
      )
    ).click()
  }
  const item = await until('设备列表上的本机', () =>
    one('[data-detail]') ? null : one('.devp-item[data-device="local"]'),
  )
  const flagged = Boolean(one('[data-flag="service"]', item))
  one<HTMLButtonElement>('.devp-row', item)?.click()
  // 设备进程刚起来时可能还没拿到主进程报的来历，核心会补问：等这一节出来
  const section = await until('“设备服务”一节', () =>
    one<HTMLElement>('[data-detail] [data-sec="service"]'),
  )
  const head = [
    section.dataset.open,
    section.dataset.notice ?? '没有要说的',
    text(one('.mng-sum', section)),
    text(one('[data-service-pill]', section)),
  ].join(':')
  one<HTMLButtonElement>('.fold', section)?.click()
  await until('这一节点开', () => one('[data-sec="service"] .mng-sec-body'))
  const fact = (name: string) => one(`[data-sec="service"] [data-fact="${name}"]`)
  const facts = [
    text(fact('version')),
    fact('bundled') ? text(fact('bundled')) : '没有这一行',
    `${fact('origin')?.dataset.origin}:${text(fact('origin'))}`,
    fact('launch')?.dataset.detached ?? '',
    text(fact('started')) ? '有启动时间' : '没有启动时间',
    /^\d+$/.test(text(fact('pid'))) ? '有进程号' : '没有进程号',
  ].join('｜')
  const notes = document.querySelectorAll('[data-sec="service"] .svc-note').length
  return { head, facts, notes, flagged }
}

const judging = () => {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const same = (actual: unknown, expected: unknown, what: string) =>
    must(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`,
    )
  return { failed, must, same }
}

/** 对着模拟核心量到的东西，哪些算不合格 */
export function judgeMockService(probe: MockServiceProbe): string[] {
  const { failed, must, same } = judging()
  const kinds = (list: string[]) => list.map((entry) => entry.split('=')[0])
  same(probe.engagedBefore, 0, '开头本机还有在跑、在等人的会话，这一段的前提不成立')

  // 平时：看得到版本，这一节收着，没有说明，列表行上没有记号
  same(probe.flagsBefore, [], '平时设备列表的行上不该有服务的记号')
  same(probe.localHead, 'false:没有要说的:0.7.0:', '本机平时“设备服务”一节的样子不对')
  same(
    probe.localFacts,
    '0.7.0｜0.7.0｜bundled:应用自带的适配器｜true｜有启动时间｜有进程号',
    '本机的设备服务没有摆全（版本｜应用自带｜来源｜按需拉起｜启动时间｜进程号）',
  )
  same(probe.remoteHead, 'false:没有要说的:0.7.0:', '远程设备“设备服务”一节的样子不对')
  same(
    probe.remoteFacts,
    '0.7.0｜没有这一行｜path:/home/dev/.local/share/codex-harness-adapter/0.7.0/libexec｜false｜有启动时间｜有进程号',
    '远程的设备服务没有摆对：来源要给路径，没有“应用自带”一行',
  )
  same(
    probe.absent,
    ['nas:没有这一节', 'gpu:没有这一节'],
    '没有设备服务的、没连上的设备不该有这一节',
  )

  // 旧而忙没换
  same(probe.flagsBusy, ['local'], '旧而忙没换时，只有本机那一行该有记号')
  same(
    probe.busyHead,
    'true:busy:0.6.0:比应用自带的版本旧',
    '旧而忙没换时这一节没有自己开着，或者标题行不对',
  )
  must(
    probe.busyText.includes('0.6.0') && probe.busyText.includes('0.7.0'),
    `没换成的说明里没有两边的版本：${probe.busyText}`,
  )
  same(
    kinds(probe.busyReasons),
    ['activeTurns', 'deviceProcesses', 'clients'],
    '不闲的原因没有逐条列出来',
  )
  must(
    // 示例数据里这个 harness 的名字就叫 dsh
    (probe.busyReasons[0] ?? '').includes('dsh'),
    `有回合在跑的那一条没说是哪个 harness：${probe.busyReasons[0]}`,
  )
  same(probe.retryLabel, '立即重试', '没有“立即重试”')
  same(probe.busyFolds, 'false>true', '这一节合不上，或者合上之后自己弹开了（合上之后>再点开）')

  // 再试一次，回合还停着
  same(probe.retrying, 'true:正在重新连接…', '点了“现在再试一次”之后按钮的样子不对（不能再点:字）')
  same(probe.stillToast, '设备服务仍在忙碌，本次仍未更新', '还不闲时再试，没有说结果')
  same(kinds(probe.stillReasons), ['activeTurns'], '再试之后原因没有换成现在的')
  same(probe.stillHead, 'true:busy:0.6.0:比应用自带的版本旧', '还不闲时再试，这一节不该变')

  // 闲了再试：换上了
  must(probe.doneToast.includes('0.7.0'), `换成之后的提示没说换成了哪版：${probe.doneToast}`)
  same(probe.replacedHead, 'true:replaced:0.7.0:已从 0.6.0 更新', '换上新版之后这一节的标题行不对')
  must(
    probe.replacedText.includes('0.6.0 → 0.7.0'),
    `换上新版的那句话没说从哪版到哪版：${probe.replacedText}`,
  )
  must(!probe.replacedHasRetry, '换上新版之后不该还有“现在再试一次”')
  same(probe.flagsAfter, [], '换上新版之后列表行上的记号该没了')

  // 另外几种
  const [front = '', frontCommands = ''] = (probe.scenes.服务是前台的 ?? '').split('｜')
  same(
    front,
    'true:foreground:0.6.0:比应用自带的版本旧',
    '前台的或者有服务管理器管着的，这一节不对',
  )
  same(
    frontCommands,
    'brew upgrade codex-harness-adapter && brew services restart codex-harness-adapter',
    '前台的或者有服务管理器管着的，没有给该怎么换的命令',
  )
  const [old = '', oldCommands = '', oldSaid = ''] = (probe.scenes.服务太旧 ?? '').split('｜')
  same(old, 'true:unsupported:未报告版本:比应用自带的版本旧', '太旧、停不了的，这一节不对')
  same(oldCommands, 'ps -p 4821 -o command= && kill 4821', '太旧、停不了的，没有给手工结束的命令')
  must(oldSaid.includes('4821'), `太旧、停不了的，没有带命令行的原话：${oldSaid}`)
  const [stuck = '', stuckCommands = '', stuckSaid = ''] = (probe.scenes.服务没停成 ?? '').split(
    '｜',
  )
  same(stuck, 'true:failed:0.6.0:比应用自带的版本旧', '去停了没停成的，这一节不对')
  same(stuckCommands, '', '去停了没停成的，不该给命令')
  must(stuckSaid.includes('没有退出'), `去停了没停成的，没有带命令行的原话：${stuckSaid}`)
  same(
    probe.scenes.服务比应用新,
    'false:没有要说的:0.8.0:｜｜',
    '比应用自带的新：只显示版本，不打扰',
  )
  same(
    probe.sceneFlags,
    { 服务是前台的: ['local'], 服务太旧: ['local'], 服务没停成: ['local'], 服务比应用新: [] },
    '列表行上的记号只该在“旧而且没换成”时有',
  )
  return failed
}

/** 对着真的设备服务量到的东西，哪些算不合格 */
export function judgeService(probe: ServiceProbe): string[] {
  const { failed, must, same } = judging()
  const [open = '', notice = '', version = '', pill = ''] = probe.head.split(':')
  same(
    [open, notice, pill],
    ['false', '没有要说的', ''],
    '真的设备服务：这一节平时该收着、没有要说的',
  )
  const [shown = '', bundled = '', origin = '', detached = '', started = '', pid = ''] =
    probe.facts.split('｜')
  must(
    /^\d+\.\d+\.\d+/.test(version) && shown === version,
    `没看到设备服务的版本：${probe.head}｜${shown}`,
  )
  // 这里应用连的是现成的入口，外壳没有管服务的生死：没有“应用自带”那一行，来源照实给路径
  same(bundled, '没有这一行', '没有换版本这回事的时候不该有“应用自带”一行')
  must(/^path:\//.test(origin), `来源没有给出那份适配器的路径：${origin}`)
  // 夹具里的主进程是在前台起的
  same(detached, 'false', '怎么起的没有读对（夹具里的主进程是前台运行的）')
  same([started, pid], ['有启动时间', '有进程号'], '启动时间或者进程号没有摆出来')
  same(probe.notes, 0, '不该有换版本的说明')
  must(!probe.flagged, '设备列表的行上不该有记号')
  return failed
}
