// 完整模式收尾的验收（模拟核心这一半）：整理侧栏、按声明给入口、不可用之后的下一步。
// 跟在 mockFullProbe 和设备列表那一组后面，在同一个窗口里接着量（见 smoke.mts）。
// 对着真设备的那一半在 probe-organize.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface OrganizeMockProbe {
  /** 置顶组和分区组 */
  groups: {
    /** 本机下面最前头是“置顶”，里面是那两个置顶的会话，先置顶的在前 */
    pinnedFirst: boolean
    /** 接着是别处建的分区“稍后看”，里面是放进去的那一个 */
    sectionNext: boolean
    /** 置顶的、分区里的会话不再出现在项目里：每个标题在侧栏里只有一行 */
    shownOnce: boolean
    /** 挑过颜色的项目名字前面有色块，没挑过的没有 */
    colorDot: boolean
    /** 会话的信息卡：项目、目录、置顶都在卡片里（行上没有这些字） */
    sessionCard: boolean
  }
  /** 置顶、取消置顶、移出分区、移到另一个项目 */
  place: {
    pinned: boolean
    unpinned: boolean
    /** 分区里的那一个：菜单里是“移出…”和“置顶”；移出之后回到它的项目，空了的分区不再画 */
    sectionMenu: boolean
    unsectioned: boolean
    /** “移到项目…”换成一屏选项：只列别的项目；挑了之后这一行换到那个项目下面 */
    moveChoices: boolean
    moved: boolean
  }
  /** 项目的添加、改名换色、调顺序、删除 */
  workspace: {
    /** 添加：没填目录不能提交；目录不是完整路径，核心拒绝，对话框留着并说了原因 */
    addGated: boolean
    rootRefused: boolean
    /** 候选目录来自还没归进项目的会话；点一下填进去，名字默认是目录的最后一段 */
    candidate: boolean
    /** 本机的设备有“选择…”：点了弹系统的选文件夹对话框（自检里由 LITCH_PICK_FOLDER 代答），选的目录填进去 */
    browsed: boolean
    /** 加成了：排在最后，带着挑的颜色；工作目录在它下面的那个会话归了进去 */
    added: boolean
    adopted: boolean
    /** 头一个没有“上移”，最后一个没有“下移” */
    menuEnds: boolean
    /** 改名换色：对话框里目录只读；保存之后行上是新名字、新颜色 */
    edited: boolean
    movedUp: boolean
    /** 删除先问一句，写明只删记录；确认之后项目没了，里面的会话回到“无项目” */
    deleteAsked: boolean
    deleted: boolean
  }
  /** 别的客户端置顶了正开着的会话、又建了一个项目：这边什么都没点，侧栏自己跟上 */
  elsewhere: { pinned: boolean; workspace: boolean }
  /** 按声明给入口 */
  declared: {
    /** 声明了不会分叉、回退、压缩、删除的（dsh）：这几个入口不出；都会的（Claude Code）有 */
    hidden: boolean
    shownOnOthers: boolean
    noDelete: boolean
    /** 权限预设用它声明的那几档和它自己的说明；只有一档的显示成现在这一档；没有声明的是内置的说法 */
    presetNotes: boolean
    solePreset: boolean
    builtinPresets: boolean
    /** 不认识“拒绝并附说明”的（设备服务代报的 Codex）：审批卡片上没有写说明的入口；带规则的“以后都允许”画得出来 */
    noNote: boolean
    ruleShown: boolean
  }
  /** 不可用的原因：种类、界面自己说的原因和下一步、设备的原话，中英文各看一遍 */
  reasons: {
    zh: boolean
    en: boolean
    /** 新建会话的选择器里，选不了的那一项也说了下一步 */
    pickerNext: boolean
  }
  /** 看到的原样。判不过的时候靠它知道差在哪 */
  seen: Record<string, string>
}

/** 自检里系统的选文件夹对话框“选中”的目录（smoke.mts 经 LITCH_PICK_FOLDER 交给主进程） */
export const PICKED_FOLDER = '/Users/dev/notes/picked'

export async function organizeMockProbe(): Promise<OrganizeMockProbe> {
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
  const write = (target: HTMLTextAreaElement | HTMLInputElement, words: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: Element, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const say = async (words: string) => {
    const input = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    write(input, words)
    await frame()
    press(input, 'Enter')
    await frame()
  }
  const seen: Record<string, string> = {}
  /** 侧栏里的本机 */
  const local = () => one('.dev-group') as HTMLElement
  const rowsOf = (title: string) =>
    all('.ss-row').filter((row) => text(one('.title', row)) === title)
  const rowOf = (title: string) => rowsOf(title)[0]
  /** 这个会话现在画在哪一组里（和数据副本里分组的键一样）。不在侧栏里是 undefined */
  const groupOf = (title: string) =>
    rowOf(title)?.closest<HTMLElement>('[data-group]')?.dataset.group
  /** 本机下面各组的键，从上到下 */
  const groupKeys = () => all('[data-group]', local()).map((group) => group.dataset.group ?? '')
  const titlesIn = (group: string) =>
    all(`[data-group="${group}"] .ss-row .title`, local()).map(text)
  /** 项目那一行（按名字找） */
  const workspaceLine = (name: string) =>
    all('[data-workspace]', local()).find((line) => text(one('.name', line)) === name)
  const workspaceNames = () => all('[data-workspace] .name', local()).map(text)
  const open = async (title: string) => {
    ;(await until(`侧栏里的“${title}”`, () => rowOf(title))).click()
    await until(`“${title}”的内容`, () => text(one('.crumb b')) === title && one('.turn'))
    await frame()
  }
  /** 点开一行行尾的“更多” */
  const menuOf = async (line: Element | null | undefined, what: string) => {
    if (!line) throw new Error(`侧栏里没有${what}`)
    ;(
      await until(`${what}的“更多”`, () => one<HTMLButtonElement>('.row-more > .ibtn', line))
    ).click()
    return until(`${what}的菜单`, () => one('.row-more .pick-pop', line))
  }
  const items = (pop: Element) => all('.pick-opt', pop).map(text).join('|')
  const closeMenu = async (pop: Element) => {
    press(document.activeElement ?? pop, 'Escape')
    await until('菜单收起', () => !pop.isConnected)
  }
  /** 从一行的菜单里点一项 */
  const choose = async (line: Element | null | undefined, what: string, action: string) => {
    const pop = await menuOf(line, what)
    const entry = one<HTMLButtonElement>(`.pick-opt[data-action="${action}"]`, pop)
    if (!entry) throw new Error(`${what}的菜单里没有 ${action}：${items(pop)}`)
    entry.click()
    await frame()
    return pop
  }
  const lineOf = (title: string) => rowOf(title)?.closest('.row-line')
  /** 鼠标停到一行上，等信息卡出来。看完点一下让它收起 */
  const hover = async (line: Element, what: string) => {
    line.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    const card = await until(`${what}的信息卡`, () => one('.info-card'), 10_000)
    return {
      card,
      close: async () => {
        line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        await until('信息卡收起', () => !one('.info-card'))
      },
    }
  }

  // 前面的验收可能停在设备页上：先回到一个会话里
  const P1 = '发版前的检查清单'
  const P2 = '文档站的待办汇总'
  const K1 = '读一遍 launchd 的日志轮转'
  await open('远程设备安装指引')

  // ---- 一、置顶组和分区组 ----
  const keys = groupKeys()
  seen.groups = keys.join(' ')
  seen.pinned = titlesIn(':pinned').join('|')
  const sectionKey = keys.find((key) => key.startsWith(':section:')) ?? ''
  const labelOf = (group: string) => text(one(`[data-group="${group}"] > .sec-label`, local()))
  const card = await hover(lineOf(P1) as Element, '置顶会话')
  const info = text(one('[data-session-info]', card.card))
  seen.sessionCard = info
  await card.close()
  const groups: OrganizeMockProbe['groups'] = {
    pinnedFirst:
      keys[0] === ':pinned' &&
      labelOf(':pinned') === '置顶' &&
      titlesIn(':pinned').join('|') === `${P1}|${P2}`,
    sectionNext:
      keys[1] === sectionKey &&
      labelOf(sectionKey) === '稍后看' &&
      titlesIn(sectionKey).join('|') === K1,
    shownOnce: [P1, P2, K1].every((title) => rowsOf(title).length === 1),
    colorDot:
      Boolean(one('.ws-dot', workspaceLine('litch'))) &&
      !one('.ws-dot', workspaceLine('docs-site')),
    sessionCard:
      info.includes('litch') &&
      info.includes('~/work/litch') &&
      info.includes('置顶') &&
      !text(rowOf(P1)).includes('~/work/litch'),
  }

  // ---- 二、置顶、取消置顶、移出分区、移到另一个项目 ----
  const S3 = 'Pi 入口过早上报最终回答'
  await choose(lineOf(S3), S3, 'pin')
  await until('它到了置顶组里', () => groupOf(S3) === ':pinned')
  // 后置顶的排在后面
  const pinned = titlesIn(':pinned').join('|') === `${P1}|${P2}|${S3}`
  await choose(lineOf(S3), S3, 'unpin')
  await until('它回到项目里', () => groupOf(S3) === 'litch')
  const unpinned = titlesIn(':pinned').join('|') === `${P1}|${P2}`
  const sectionPop = await menuOf(lineOf(K1), K1)
  seen.sectionMenu = items(sectionPop)
  const sectionMenu = seen.sectionMenu.startsWith('移出“稍后看”|置顶|')
  one<HTMLButtonElement>('.pick-opt[data-action="unsection"]', sectionPop)?.click()
  await until('它回到项目里', () => groupOf(K1) === 'litch')
  const unsectioned = !groupKeys().some((key) => key.startsWith(':section:'))
  const S7 = '能力矩阵页改成从声明生成'
  const movePop = await choose(lineOf(S7), S7, 'move')
  const targets = await until('可以移去的项目', () => {
    const found = all('.pick-choice', movePop)
    return found.length > 0 ? found : null
  })
  seen.moveChoices = targets.map(text).join('|')
  // 只列别的项目（它现在在 docs-site 里）；挑过颜色的带着色块
  const moveChoices = seen.moveChoices === 'litch' && Boolean(one('.ws-dot', targets[0]))
  targets[0]?.click()
  await until('它换到了那个项目下面', () => groupOf(S7) === 'litch')
  const place: OrganizeMockProbe['place'] = {
    pinned,
    unpinned,
    sectionMenu,
    unsectioned,
    moveChoices,
    moved: rowsOf(S7).length === 1,
  }

  // ---- 三、项目：添加、改名换色、调顺序、删除 ----
  const dialog = () => one<HTMLDialogElement>('dialog.ws-dialog[open]')
  const submit = () => one<HTMLButtonElement>('.ws-dialog .btn.primary')
  const S9 = '查一下 launchd 的 KeepAlive 语义'
  const ROOT = '/Users/dev/notes/launchd'
  await choose(one(':scope > .row-line', local()), '本机', 'addWorkspace')
  await until('添加项目的对话框', dialog)
  const rootField = await until('目录那一栏', () => one<HTMLInputElement>('#ws-root'))
  const addGated = submit()?.disabled === true
  write(rootField, 'notes/launchd')
  await until('可以提交', () => submit()?.disabled === false)
  submit()?.click()
  const refusal = text(await until('核心拒绝的原因', () => one('.ws-dialog .modal-note.err')))
  seen.rootRefused = refusal
  const rootRefused = refusal.includes('完整路径') && Boolean(dialog())
  const candidates = all('.ws-dialog .ws-root')
  seen.candidates = candidates.map(text).join('|')
  // 和外面的 PICKED_FOLDER 是同一个：这个函数被原样送进页面里执行，引用不到外面的
  const PICKED = '/Users/dev/notes/picked'
  const browse = one<HTMLButtonElement>('.ws-dialog .ws-browse')
  browse?.click()
  const browsed = browse
    ? Boolean(
        await until('选的目录填进了目录那一栏', () => rootField.value === PICKED, 5000).catch(
          () => null,
        ),
      )
    : false
  candidates.find((entry) => text(entry) === ROOT)?.click()
  await until('候选填进了目录那一栏', () => rootField.value === ROOT)
  const candidate = one<HTMLInputElement>('#ws-name')?.placeholder === 'launchd'
  one<HTMLButtonElement>('.ws-colors button[aria-label="violet"]')?.click()
  await frame()
  submit()?.click()
  await until('对话框关掉', () => !dialog())
  await until('新的项目出现在侧栏里', () => workspaceLine('launchd'))
  seen.added = workspaceNames().join('|')
  const dotOf = (name: string) => one('.ws-dot', workspaceLine(name))?.getAttribute('style') ?? ''
  const added = seen.added === 'litch|docs-site|launchd' && dotOf('launchd').includes('violet')
  const launchdKey = workspaceLine('launchd')?.dataset.workspace ?? '\0'
  const adopted = Boolean(await until('它下面的会话归了进去', () => groupOf(S9) === launchdKey))
  // 头一个没有“上移”，最后一个没有“下移”
  const firstPop = await menuOf(workspaceLine('litch'), '头一个项目')
  seen.firstMenu = items(firstPop)
  await closeMenu(firstPop)
  const lastPop = await menuOf(workspaceLine('launchd'), '最后一个项目')
  seen.lastMenu = items(lastPop)
  const menuEnds =
    seen.firstMenu === '改名与颜色…|下移|删除' && seen.lastMenu === '改名与颜色…|上移|删除'
  one<HTMLButtonElement>('.pick-opt[data-action="edit"]', lastPop)?.click()
  await until('改名与颜色的对话框', dialog)
  const nameField = await until('名字那一栏', () => one<HTMLInputElement>('#ws-name'))
  const fixedRoot =
    nameField.value === 'launchd' && !one('#ws-root') && text(one('.ws-fixed')) === ROOT
  write(nameField, '日志笔记')
  one<HTMLButtonElement>('.ws-colors button[aria-label="red"]')?.click()
  await frame()
  submit()?.click()
  await until('对话框关掉', () => !dialog())
  await until('行上是新的名字', () => workspaceLine('日志笔记'))
  const edited = fixedRoot && dotOf('日志笔记').includes('red') && !workspaceLine('launchd')
  await choose(workspaceLine('日志笔记'), '改了名的项目', 'up')
  await until(
    '它挪到了前一个的前面',
    () => workspaceNames().join('|') === 'litch|日志笔记|docs-site',
  )
  const movedUp = true
  const deletePop = await choose(workspaceLine('日志笔记'), '改了名的项目', 'delete')
  const asking = await until('删除之前的那一问', () => one('.pick-ask', deletePop))
  seen.deleteAsk = text(asking)
  const deleteAsked =
    seen.deleteAsk.includes('只删掉项目这条记录') && Boolean(workspaceLine('日志笔记'))
  one<HTMLButtonElement>('.btn.danger', asking)?.click()
  await until('项目没了', () => !workspaceLine('日志笔记'))
  const deleted = Boolean(await until('里面的会话回到“无项目”', () => groupOf(S9) === ''))
  const workspace: OrganizeMockProbe['workspace'] = {
    addGated,
    rootRefused,
    candidate,
    browsed,
    added,
    adopted,
    menuEnds,
    edited,
    movedUp,
    deleteAsked,
    deleted,
  }

  // ---- 四、别处改了：这边什么都没点，侧栏自己跟上 ----
  const S6 = '远程设备安装指引'
  await open(S6)
  const claudeHasFork = Boolean(await until('消息上的分叉按钮', () => one('.umsg .act-fork')))
  await say('别处整理一下')
  await until('别处把它置顶了', () => groupOf(S6) === ':pinned')
  await until('别处建的项目', () => workspaceLine('别处建的'))
  await until('这个回合结束', () => !one('.running-line'))
  const elsewhere: OrganizeMockProbe['elsewhere'] = {
    pinned: one('.ss-row.sel') === rowOf(S6),
    workspace: dotOf('别处建的').includes('orange'),
  }

  // ---- 五、按声明给入口 ----
  /** 点开权限的选择器，把里面每一项的标题和说明读出来 */
  const presets = async () => {
    const button = await until('权限的选择器', () =>
      one<HTMLButtonElement>('.pick[data-kind="permission"] .pick-btn'),
    )
    const shown = text(button)
    button.click()
    const options = await until('权限的选项', () => {
      const found = all('.pick[data-kind="permission"] .pick-opt')
      return found.length > 0 ? found : null
    })
    const read = options.map((option) => `${text(one('b', option))}：${text(one('span', option))}`)
    press(document.activeElement ?? button, 'Escape')
    await until('选择器收起', () => !one('.pick[data-kind="permission"] .pick-pop'))
    return { shown, read }
  }
  const S4 = '设备进程的转发开销基准'
  await open(S4)
  await until('这个会话的消息', () => one('.umsg'))
  await until('底栏', () => one('.cmp-bar .pick'))
  const hidden = !one('.umsg .act-fork') && !one('.umsg .act-rollback') && !one('.cmp-bar .ctx-btn')
  const dshPop = await menuOf(lineOf(S4), S4)
  seen.dshMenu = items(dshPop)
  await closeMenu(dshPop)
  const dsh = await presets()
  seen.dshPresets = dsh.read.join('｜')
  await open(S3)
  const pi = await presets()
  seen.piPresets = `${pi.shown}：${pi.read.join('｜')}`
  await open('整理快照保留策略')
  const bare = await presets()
  seen.barePresets = bare.read.join('｜')
  await open('核对构建机上的 codex 配置')
  await say('跑一条要审批的命令')
  const request = await until('审批卡片', () => one('.req'))
  await frame()
  seen.codexOptions = all('.req-actions .btn', request).map(text).join('|')
  const noNote = !one('.note-open', request)
  const ruleShown = text(one('[data-option="acceptAlways"] .req-rule', request)) === 'curl -fsSL'
  one<HTMLButtonElement>('[data-option="decline"]', request)?.click()
  await until('审批卡片消失', () => !one('.req'))
  await until('这个回合结束', () => !one('.running-line'), 60_000)
  const declared: OrganizeMockProbe['declared'] = {
    hidden,
    shownOnOthers: claudeHasFork,
    noDelete: seen.dshMenu === '置顶|移到项目…|改名|归档',
    presetNotes: dsh.read.length === 3 && Boolean(dsh.read[0]?.startsWith('只读：不能改文件')),
    solePreset:
      pi.read.length === 1 &&
      pi.shown === '完全访问' &&
      pi.read[0]?.includes('Pi 没有审批') === true,
    builtinPresets: bare.read.length === 3 && Boolean(bare.read[0]?.startsWith('只读：只能看。')),
    noNote,
    ruleShown,
  }

  // ---- 六、不可用的原因：界面自己说原因和下一步，设备的原话排在后面；换成英文再看一遍 ----
  const reasonOf = async () => {
    const shown = await hover(one(':scope > .row-line', local()) as Element, '本机')
    const why = one('.harness-entry[data-harness="codex"] .harness-why', shown.card)
    const read = [
      why?.dataset.down ?? '',
      text(one('.harness-reason', why ?? shown.card)),
      text(one('.harness-next', why ?? shown.card)),
      text(one('.harness-said', why ?? shown.card)),
    ]
    await shown.close()
    return read
  }
  const zh = await reasonOf()
  seen.reasonZh = zh.join('｜')
  // 换语言走界面给验收留的口子，不靠界面上哪个按钮（AGENTS.md“验收里换外观”）
  const look = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const devicesLink = () => text(one('.sb-link.devices'))
  look.set({ lang: 'en' })
  await until('界面换成英文', () => devicesLink() === 'Devices')
  const en = await reasonOf()
  seen.reasonEn = en.join('｜')
  look.set({ lang: 'zh-CN' })
  await until('界面换回中文', () => devicesLink() === '设备')
  ;(
    await until('设备行上的新建按钮', () => one<HTMLButtonElement>('.dev-row ~ .row-add', local()))
  ).click()
  const harnessPicker = await until('选 harness 的选择器', () =>
    one<HTMLButtonElement>('.pick[data-kind="harness"] .pick-btn'),
  )
  harnessPicker.click()
  const off = await until('选不了的那一项', () =>
    one('.pick[data-kind="harness"] .pick-opt[data-option="codex"]'),
  )
  seen.pickerNote = text(one('span', off))
  press(document.activeElement ?? harnessPicker, 'Escape')
  await open(S6)
  const reasons: OrganizeMockProbe['reasons'] = {
    zh:
      zh[0] === 'notInstalled' &&
      zh[1] === '这台设备上没有装' &&
      Boolean(zh[2]?.includes('装好它的命令行')) &&
      Boolean(zh[3]?.includes('没有找到 codex')),
    en:
      en[0] === 'notInstalled' &&
      en[1] === 'Not installed on this device' &&
      Boolean(en[2]?.includes('Install its command-line tool')) &&
      Boolean(en[3]?.includes('codex was not found')),
    pickerNext:
      seen.pickerNote.includes('这台设备上没有装') && seen.pickerNote.includes('装好它的命令行'),
  }

  return { groups, place, workspace, elsewhere, declared, reasons, seen }
}

/** 哪些项不合格。全过就是空的 */
export function judgeOrganizeMock(probe: OrganizeMockProbe): string[] {
  const failed: string[] = []
  const { seen, ...sections } = probe
  const names: Record<string, string> = {
    groups: '置顶组和分区组',
    place: '置顶和移动会话',
    workspace: '项目的增删改和排序',
    elsewhere: '别处改了这边跟上',
    declared: '按声明给入口',
    reasons: '不可用的原因和下一步',
  }
  for (const [section, checks] of Object.entries(sections)) {
    for (const [name, ok] of Object.entries(checks)) {
      if (!ok) failed.push(`${names[section] ?? section}：${name} 不对`)
    }
  }
  if (failed.length > 0) failed.push(`看到的：${JSON.stringify(seen)}`)
  return failed
}
