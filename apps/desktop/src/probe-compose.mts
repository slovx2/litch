// 输入区的验收：输入法、发送、流式、排队、打断、草稿，以及审批和提问的卡片。
// 和 probe-scroll.mts 一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 对着模拟核心时多量一遍请求卡片（隔离入口里的 Pi 引擎不发审批）；
// 对着真实入口时多看一眼每条回话有没有对上发出去的那一句（假模型会把收到的话带回来），
// 再让引擎真的问两个问题（话里带“问我”，见 scripts/client-fixture-ask.mjs），答完看回话里有没有这两个回答。

export interface ComposeProbe {
  /** 输入法还在选词时按回车：没有发出去，字还在 */
  imeKept: boolean
  /** 按下回车到这条消息出现在对话里，隔了多久（毫秒） */
  bubbleMs: number
  /** 回话是一段一段到的：正在输出的那段文字变长了几次 */
  streamSteps: number
  /**
   * 流式输出的全过程里，各条回答显示出来的字有没有哪一刻不是最终文字开头的一截。
   * 这里列的是那些不对的样子（最多五个，各截前 60 个字），空的就是没有
   */
  streamStray: string[]
  /** 上一项一共看到了多少种中间的样子（证明确实量到了流式的过程） */
  streamShapes: number
  /** 定稿之后的回答里，开头那几个字有没有在后面又出现一遍 */
  streamRepeated: boolean
  /** 回合进行中又发了三条：对话里这四条用户消息的顺序 */
  order: string[]
  /** 排队期间托盘里最多同时有几条 */
  queuedMax: number
  /** 每条回话有没有带上对应的那句话。只在真实入口上量 */
  echoed: boolean | null
  /** 引导：排着的那条点“现在就说”，它从托盘里出来、进了正在进行的回合，没有多出一个回合 */
  steered: boolean
  /** 点了停止之后回合有没有停下来、有没有标成已中断 */
  interrupted: boolean
  /**
   * 插进去的话最后有没有着落：要么留在被打断的那个回合里（对面已经收下），
   * 要么作为下一个回合发了出去（对面没来得及收）。不能凭空没了，也不能出现两遍
   */
  steerSettled: boolean
  /** 写了一半的草稿：别的会话里看不到它，切回来还在 */
  draftIsolated: boolean
  draftKept: boolean
  /** 切走再回来，对话里的用户消息和离开时一样 */
  reopenSame: boolean
  /** 不一样的时候，离开前和回来后各是什么 */
  reopenDiff: { before: string[]; after: string[] } | null
  /** 图片贴进输入框就成了待发的附件；一起贴进来的不是图片的文件不收，并说明原因 */
  imagePasted: boolean
  imageRefusedOther: boolean
  /** 带着图的草稿：别的会话里看不到，切回来还在 */
  imageDraftKept: boolean
  /** 发出去之后气泡里有缩略图，占的地方是固定的；输入区里的图清掉了 */
  imageShown: boolean
  /** 缩略图点开能看大图，能关上 */
  imageViewed: boolean
  /** 回合结束之后缩略图还在：对面回显的消息里图没有丢 */
  imageKept: boolean
  /** 图有没有真的到了模型手里。只在真实入口上量 */
  imageDelivered: boolean | null
  /** 底栏上模型那个选择器有没有显示出当前的模型 */
  modelShown: boolean
  /** 换到没有强度档的模型，强度的选择器跟着消失；换回来又出现。只在模拟核心上量 */
  effortFollowsModel: boolean | null
  /**
   * 原生 codex 的会话没配强度时（对面报的强度是 null）底栏的强度显示成什么，应是模型默认的那一档。
   * 只在模拟核心上量（模拟的 codex 照真的报 null）
   */
  effortDefault: string | null
  /**
   * 模型多的选择器顶上的筛选框：点开时焦点在框里，写“mini”只剩名字带它的，回车选中头一个。
   * 只在模拟核心上量（模拟的 codex 列了九个模型）。量到的是：焦点在框里｜筛完剩下的｜回车之后按钮上写的
   */
  modelSearch: string | null
  /** 高风险的权限预设：点了先问，确认之后才换过去。只在模拟核心上量 */
  riskAsked: boolean | null
  riskSwitched: boolean | null
  /** 新建会话：按下回车到第一条消息出现在对话的位置上，隔了多久（毫秒） */
  newBubbleMs: number
  /** 建好之后落在新会话里：标题栏不再是“新会话”，对话里只有刚发的那一条，侧栏里选中的是它 */
  newLanded: boolean
  /** 新会话的第一条回话有没有对上。只在真实入口上量 */
  newEchoed: boolean | null
  /** 侧栏上给会话改名：输入框得焦点，回车之后侧栏和标题栏都换成新名字 */
  renamed: boolean
  /** 归档：侧栏里不再有它；从侧栏底部进“已归档对话”那一页能看到它 */
  archived: boolean
  /** 在那一页里恢复：回到侧栏里，那一页不再有它；点开，内容还是原来的 */
  restored: boolean
  /** 删除先问一句；确认之后这一行消失，主区域回到新建对话页（不是落到别的会话里） */
  deleteAsked: boolean
  deletedHome: boolean
  /** 输入历史：光标在最前面按上箭头翻出上一次发的话，再按是更早的一条，下箭头翻回到空 */
  historyRecalled: boolean
  /** 底栏上有上下文占用的百分比 */
  contextShown: boolean
  /** 请求卡片。只在模拟核心上量 */
  cards: {
    /** 卡片一出现焦点就在它上面 */
    approvalFocus: boolean
    /** 等审批时切到别的会话：侧栏上这个会话有“待审批”的标记，切回来卡片还在 */
    keptAway: boolean
    /** 焦点在侧栏的某一行上时按回车，卡片不当成批准 */
    strayEnterIgnored: boolean
    /** 在卡片上按 Esc：拒绝，这张卡片消失 */
    declined: boolean
    /** 排在后面的 MCP 工具调用审批接着出现，焦点在它上面，有“以后都允许”；回车批准后卡片没了，焦点回到输入框 */
    toolAsked: boolean
    toolAccepted: boolean
    // ---- 提问向导，第一轮：示例里那张三道题的卡片（单选、自己写、单选） ----
    /** 标题行写着“第 1 题，共 3 题”，三个标记都是没答，上一题停用、下一题能点，焦点在卡片上 */
    wizardShown: boolean
    /** 焦点在侧栏的某一行上时按右箭头、数字键，卡片不翻题也不选 */
    strayKeysIgnored: boolean
    /** 没答也能翻：右箭头到第二题，焦点进了输入框；输入框里按左箭头是挪光标，不翻题；写了字回车到第三题 */
    flipped: boolean
    /** 最后一题选完，前面还有没答的：不交，跳到第一道没答的题并说明 */
    lastGated: boolean
    /** 点了选项：马上显示选中，不用再按什么，过一小会儿自己到下一题 */
    autoAdvanced: boolean
    /** 往回翻，之前选的还选着；改了答案照常到下一题，不因为后面都答过了就交卷 */
    changedAdvances: boolean
    /** 选完没等它前进又点了别的选项、又翻了题：算最后一次，只前进一步 */
    lastWins: boolean
    /** 选完没等它前进就切走会话：回来还在这一题，各题填的、写的字都在 */
    draftKept: boolean
    /** 上下箭头在选项间移动，不自己前进；过了最后一项进“其他”，焦点进输入框；输入框里按上箭头回到选项里；左箭头翻回上一题 */
    arrowsMoved: boolean
    /** 最后一题点了选项，每道题都有了说法：不用再按什么，卡片换成了排在后面的表单 */
    autoSubmitted: boolean
    /** 表单答完之后的回话里，三道题各自收到的回答和界面上最后填的一样 */
    answersMatched: boolean
    // ---- 第二轮：话里带“提问”再问一次 ----
    /** 点“跳过”：这道题的标记变成跳过，到了下一题；翻回去看写着跳过了 */
    skipped: boolean
    /** 点“提交”时还有没答的：不交，跳到那道题并说明 */
    submitGated: boolean
    /** 最后一题上按回车交了卷；回话里跳过的两道写着跳过，答了的那道对得上 */
    skippedSent: boolean
    // ---- 第三轮：话里带“问一句”，只有一道题 ----
    /** 没有标记排和翻题按钮，没有多出“其他”；按数字键选了就交，回话里的回答对得上 */
    singleAuto: boolean
    /** 排在后面的表单接着出现，焦点落在第一个输入框里 */
    formFocused: boolean
    /** 必填的没填就提交：不发，指出是哪一栏 */
    formChecked: boolean
    /** 对面定了范围的一栏（1 到 20）：栏下写着范围；填了出界的数就提交，不发并说清是哪一头 */
    formBounded: boolean
    /** 填好之后回车：发出去，卡片消失 */
    formSent: boolean
  } | null
  /** 会话多的项目：只露出最近的几个，其余的收在“展示更多”后面。只在模拟核心上量 */
  folded: {
    /** 先只露出五个，旁边写着还有几个 */
    first: boolean
    /** 点“展示更多”全露出来，按钮换成“收起” */
    expanded: boolean
    /** 选中折在后面的那个再收起：它还露着，其余的折回去 */
    keptSelected: boolean
  } | null
  /**
   * 提问向导在三种皮肤、深浅色下的样子，一种一行：“皮肤/明暗:各处的对比度…:放不放得下”。只在模拟核心上量。
   * 对比度依次是：题目、标题行、没答的说明、没答的标记、答了的标记上的字对它的底、答了的标记的底对卡片、
   * 跳过的标记、跳过的说明、选中的选项的字对它的底、选中的选项的说明对它的底
   */
  wizardSkins: string[] | null
  /** 引擎真的发来的提问。只在真实入口上量 */
  asked: {
    /** 问题成了卡片，焦点在它上面，三个选项都在，没有多出“其他”；只有一道题，没有各题的标记 */
    shown: boolean
    /** 数字键选了第二个，不用再按什么这一问就交了；第二问没有选项，输入框一出现焦点就在里面 */
    typedFocus: boolean
    /** 等回答的时候侧栏上这个会话有“待回答”的标记 */
    marked: boolean
    /** 两问都答完，卡片消失，回话里带着这两个回答，焦点回到输入框（它一直都在） */
    answered: boolean
    /** 答完之后那条回话流出来的全过程里，显示的字始终是最终文字开头的一截 */
    clean: boolean
  } | null
}

export async function composeProbe(real: boolean): Promise<ComposeProbe> {
  // 这一段量的是排队：回合进行中发的消息先排着（设置里默认是立即发送，见 probe-compose-send.mts）
  const sendMode = (window as unknown as { __litchSendMode?: { set(mode: string): void } })
    .__litchSendMode
  if (!sendMode) throw new Error('界面上没有给验收换发送方式的口子（window.__litchSendMode）')
  sendMode.set('queue')
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
  const one = <E extends Element = HTMLElement>(selector: string) =>
    document.querySelector<E>(selector)
  const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const users = () => all('.umsg-text').map((element) => element.textContent?.trim() ?? '')
  const running = () => Boolean(one('.running-line'))
  const liveLength = () => one('.md.live')?.textContent?.length ?? 0
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((element) => element.textContent?.includes(title)),
    )
    row.click()
    await until(
      `“${title}”的内容`,
      () => one('.crumb')?.textContent?.includes(title) && one('.turn'),
    )
    await frame()
  }
  /** 往受控的输入框里写字：直接赋值界面不知道，要走原生的设值再发一个输入事件 */
  const write = (target: HTMLTextAreaElement | HTMLInputElement, text: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  /** 在输入框里写一句话，按回车 */
  const say = async (text: string) => {
    const input = await until('输入框', area)
    write(input, text)
    await frame()
    press(input, 'Enter')
    await frame()
  }

  /**
   * 盯着对话区里露在外面的回答：页面每变一次，记下每一条回答这时显示成什么样。
   * 流式输出的全过程里，显示出来的字应当始终是最终文字开头的一截；出现过别的样子，
   * 就是有字被多加了一遍，等定稿才改回来。只认开始盯之后才出现的回答。
   */
  const watchAnswers = () => {
    const read = () => {
      const texts = new Map<string, string>()
      // 回答的每个顶层块带着“a:条目标识:块序号”，同一条回答的几块按顺序拼起来
      for (const block of all('.md > [data-anchor^="a:"]')) {
        const key = (block.getAttribute('data-anchor') ?? '').replace(/:\d+$/, '')
        texts.set(key, (texts.get(key) ?? '') + (block.textContent ?? ''))
      }
      return texts
    }
    const known = new Set(read().keys())
    const shapes = new Map<string, string[]>()
    const sample = () => {
      for (const [key, text] of read()) {
        if (known.has(key) || !text) continue
        const list = shapes.get(key) ?? []
        if (list.at(-1) !== text) list.push(text)
        shapes.set(key, list)
      }
    }
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    return {
      /** 回答都定稿之后调：不再盯，把看到的交出来 */
      stop() {
        observer.disconnect()
        sample()
        const lists = [...shapes.values()]
        // 不对的样子往往一来就是一长串（多出来的字一直留到定稿），留头几个就够看出是什么毛病
        const stray = lists
          .flatMap((list) => {
            const final = list.at(-1) ?? ''
            return list.filter((text) => !final.startsWith(text)).map((text) => text.slice(0, 60))
          })
          .slice(0, 5)
        const repeated = lists.some((list) => {
          const final = list.at(-1) ?? ''
          const head = final.slice(0, 6)
          return head.length === 6 && final.includes(head, 1)
        })
        return { stray, repeated, shapes: lists.reduce((sum, list) => sum + list.length, 0) }
      },
    }
  }

  const main = real ? '给首页加一个状态条' : '首页文案'
  const other = real ? '连接层的重连与对账' : '远程设备安装指引'

  // ---- 零、会话多的项目：只露出最近的几个（示例数据里 docs-site 有十二个会话） ----
  let folded: ComposeProbe['folded'] = null
  if (!real) {
    const group = await until(
      'docs-site 这个项目',
      () =>
        all('.ws-row')
          .find((row) => row.textContent?.includes('docs-site'))
          ?.closest('.row-line')?.parentElement,
    )
    const shown = () => group.querySelectorAll('.ss-row').length
    await until('项目里的会话', () => shown() > 0)
    const first =
      shown() === 5 && Boolean(group.querySelector('.ss-more')?.textContent?.includes('7'))
    group.querySelector<HTMLButtonElement>('.ss-more .more')?.click()
    await until('全部露出来', () => shown() === 12)
    const expanded =
      !group.querySelector('.ss-more .more') && Boolean(group.querySelector('.ss-more .less'))
    // 选中排在最后的那个，再收起
    const oldest = [...group.querySelectorAll<HTMLElement>('.ss-row')].at(-1)
    oldest?.click()
    await until('排在最后的那个会话被选中', () => oldest?.classList.contains('sel'))
    group.querySelector<HTMLButtonElement>('.ss-more .less')?.click()
    await until('折回去', () => shown() < 12)
    const keptSelected =
      shown() === 6 &&
      Boolean([...group.querySelectorAll('.ss-row')].at(-1)?.classList.contains('sel'))
    folded = { first, expanded, keptSelected }
  }

  // ---- 一、输入法选词时的回车不发送 ----
  await open(main)
  const input = await until('输入框', area)
  const base = users().length
  const half = '输入法里还没选完的字'
  write(input, half)
  await frame()
  press(input, 'Enter', { isComposing: true })
  await sleep(200)
  const imeKept = area()?.value === half && users().length === base

  // ---- 二、发送：消息立刻出现，回话一段一段到 ----
  const sent = ['第一条', '第二条', '第三条', '第四条']
  const answers = watchAnswers()
  write(input, sent[0] ?? '')
  await frame()
  const pressedAt = performance.now()
  press(input, 'Enter')
  await until('发出去的消息出现在对话里', () => users().length === base + 1)
  const bubbleMs = performance.now() - pressedAt
  await until('回合开始', running)

  // ---- 三、回合进行中再发三条：排队，按顺序一条一条处理 ----
  for (const text of sent.slice(1)) await say(text)
  let queuedMax = 0
  let streamSteps = 0
  let length = liveLength()
  let quietSince = 0
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    await frame()
    queuedMax = Math.max(queuedMax, all('.tray-row').length)
    const now = liveLength()
    if (now > length) streamSteps++
    length = now
    const done = users().length === base + sent.length && !running() && !one('.tray-row')
    if (!done) quietSince = 0
    else if (!quietSince) quietSince = performance.now()
    else if (performance.now() - quietSince > 400) break
  }
  const order = users().slice(base)
  const streamed = answers.stop()
  const echoed = real
    ? all('.turn')
        .slice(-sent.length)
        .every((turn, index) => turn.textContent?.includes(`收到：${sent[index]}`))
    : null

  // ---- 四、引导，然后打断 ----
  await say('这一条会被打断')
  await until('回合开始', running)
  await until('回话开始输出', liveLength)
  const turnsBefore = all('.turn').length
  await say('插进来的话')
  const steerButton = await until('托盘里的“立即插入”', () =>
    one<HTMLButtonElement>('.tray-row .mini.steer'),
  )
  steerButton.click()
  await until('插进来的话出现在对话里', () => users().includes('插进来的话'))
  await frame()
  const steered =
    !one('.tray-row') &&
    all('.turn').length === turnsBefore &&
    Boolean(all('.turn').at(-1)?.textContent?.includes('插进来的话'))
  const stop = await until('停止按钮', () => one<HTMLButtonElement>('.send.stop'))
  stop.click()
  const interrupted = Boolean(
    await until('被打断的回合停下来', () =>
      all('.turn')[turnsBefore - 1]?.querySelector('.turn-foot')?.textContent?.includes('已中断'),
    ),
  )
  // 没送达的插话会作为下一个回合发出去：等所有回合都结束
  let calm = 0
  for (const end = performance.now() + 30_000; performance.now() < end; ) {
    await frame()
    calm = running() || one('.tray-row') ? 0 : calm || performance.now()
    if (calm && performance.now() - calm > 400) break
  }
  const steerSettled = users().filter((text) => text === '插进来的话').length === 1

  // ---- 五、草稿跟着会话走；切走再回来，对话没有多也没有少 ----
  const draft = '写了一半的草稿'
  write(await until('输入框', area), draft)
  await frame()
  const before = users()
  await open(other)
  const draftIsolated = (await until('输入框', area)).value === ''
  await open(main)
  const back = await until('输入框', area)
  const draftKept = back.value === draft
  const after = users()
  const reopenSame = JSON.stringify(after) === JSON.stringify(before)
  const reopenDiff = reopenSame ? null : { before: before.slice(base), after: after.slice(base) }
  write(back, '')

  // ---- 五之二、图片：贴进来、跟着草稿走、发出去、看大图 ----
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 200
  const pen = canvas.getContext('2d')
  if (pen) {
    pen.fillStyle = '#2a7'
    pen.fillRect(0, 0, 320, 200)
    pen.fillStyle = '#135'
    pen.fillRect(40, 40, 120, 80)
  }
  const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
  if (!png) throw new Error('画不出测试用的图片')
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([png], 'image.png', { type: 'image/png' }))
  // 另一个是带不了的：不是图片，也不是文本，剪贴板里的文件对象又没有磁盘上的位置
  clipboard.items.add(new File([new Uint8Array([0x89, 0x50, 0, 1, 2, 0xff])], '说明.bin'))
  const thumbs = () => all('.cmp-att').length
  const target = await until('输入框', area)
  target.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
  )
  await until('贴进来的图片出现在输入区', () => thumbs() === 1)
  const imagePasted = target.value === ''
  const imageRefusedOther = Boolean(
    await until('不收的文件的说明', () => one('.cmp-hint.err')?.textContent?.includes('说明.bin')),
  )
  await open(other)
  await until('输入框', area)
  const imageHidden = thumbs() === 0
  await open(main)
  await until('输入框', area)
  const imageDraftKept = imageHidden && thumbs() === 1
  const withImage = '带图的一句'
  const pictured = () =>
    all('.umsg')
      .find((bubble) => bubble.textContent?.includes(withImage))
      ?.querySelector('.uimg')
  await say(withImage)
  const thumb = await until('气泡里的缩略图', pictured)
  const box = thumb.getBoundingClientRect()
  const imageShown = thumbs() === 0 && Math.round(box.width) === 96 && Math.round(box.height) === 96
  ;(thumb as HTMLElement).click()
  const viewer = await until('大图', () => one<HTMLDialogElement>('dialog.viewer[open]'))
  const seen = Boolean(
    viewer.querySelector('img')?.getAttribute('src')?.startsWith('data:image/png'),
  )
  one<HTMLButtonElement>('.viewer-x')?.click()
  await until('大图关上', () => !one('dialog.viewer'))
  const imageViewed = seen
  await until('带图的回合结束', () => !running() && !one('.tray-row'), 60_000)
  await sleep(300)
  const imageKept = Boolean(pictured())
  const imageDelivered = real
    ? Boolean(all('.turn').at(-1)?.textContent?.includes(`收到：${withImage}（图 1 张）`))
    : null

  // ---- 六、底栏：模型、强度、权限 ----
  const picker = (index: number) => all('.pick-btn')[index]
  /** 点开第 index 个选择器，选标题里带这几个字的那一项 */
  const choose = async (index: number, title: string) => {
    picker(index)?.click()
    const option = await until(`选项“${title}”`, () =>
      all('.pick-opt').find((element) => element.textContent?.includes(title)),
    )
    option.click()
    await frame()
  }
  await until('底栏的选择器', () => picker(0))
  const modelShown = (picker(0)?.textContent ?? '').trim().length > 0
  let effortFollowsModel: boolean | null = null
  let riskAsked: boolean | null = null
  let riskSwitched: boolean | null = null
  if (!real) {
    const withEffort = all('.pick-btn').length
    await choose(0, 'Haiku')
    await until('强度的选择器消失', () => all('.pick-btn').length === withEffort - 1)
    await choose(0, 'Opus')
    await until('强度的选择器回来', () => all('.pick-btn').length === withEffort)
    effortFollowsModel = true

    const last = withEffort - 1
    const beforeRisk = picker(last)?.textContent
    await choose(last, '完全访问')
    riskAsked = Boolean(one('.pick-ask')) && picker(last)?.textContent === beforeRisk
    one<HTMLButtonElement>('.pick-ask .btn.danger')?.click()
    riskSwitched = Boolean(
      await until('权限换过去', () => picker(last)?.textContent?.includes('完全访问')),
    )
  }
  let effortDefault: string | null = null
  if (!real) {
    await open('核对构建机上的 codex 配置')
    const effort = await until('强度的选择器', () =>
      one('.dock .pick[data-kind="effort"] .pick-btn'),
    )
    // 按钮的无障碍名字是“思考强度：<当前那一档>”，没有值时冒号后面是空的
    effortDefault = (effort.getAttribute('aria-label') ?? '').split('：')[1] ?? ''
  }
  let modelSearch: string | null = null
  if (!real) {
    const button = () => one<HTMLButtonElement>('.dock .pick[data-kind="model"] .pick-btn')
    ;(await until('模型的选择器', button)).click()
    const field = await until('模型的筛选框', () =>
      one<HTMLInputElement>('.dock .pick[data-kind="model"] .pick-search'),
    )
    await frame()
    const focused = document.activeElement === field
    write(field, 'mini')
    await frame()
    const left = all('.dock .pick[data-kind="model"] .pick-opt').map((option) =>
      (option.querySelector('b')?.textContent ?? '').trim(),
    )
    press(field, 'Enter')
    await until('选择器收起', () => button()?.getAttribute('aria-expanded') !== 'true', 5000)
    // 选了之后经核心改会话的设置，按钮上的字随后才换
    await until('模型换过去', () => button()?.textContent?.includes('mini'), 5000).catch(() => null)
    modelSearch = [
      focused ? '框里' : '不在框里',
      left.join('、'),
      button()?.textContent?.trim(),
    ].join('｜')
    // 换回原来的默认模型，后面的步骤照旧
    await choose(0, 'GPT-5.5 Codex')
  }

  // ---- 七、新建会话：第一条消息立刻出现，建好之后落在新会话里 ----
  const home = real ? 'app' : 'docs-site'
  const add = await until('项目行上的新建按钮', () =>
    all('.row-add').find((button) => button.parentElement?.textContent?.includes(home)),
  )
  add.click()
  await until('新建会话的页面', () => one('.new-hero'))
  const opening = '新会话的第一句'
  const fresh = await until('输入框', area)
  write(fresh, opening)
  await frame()
  const createdAt = performance.now()
  press(fresh, 'Enter')
  await until('第一条消息出现', () => users().includes(opening))
  const newBubbleMs = performance.now() - createdAt
  await until('落到新会话里', () => !one('.new-hero') && one('.ss-row.sel'))
  await until('新会话的回话结束', () => !running() && one('.turn-foot'), 60_000)
  const newLanded =
    JSON.stringify(users()) === JSON.stringify([opening]) &&
    Boolean(one('.ss-row.sel')?.textContent?.includes(opening)) &&
    Boolean(one('.crumb b')?.textContent?.includes(opening))
  const newEchoed = real ? Boolean(one('.turn')?.textContent?.includes(`收到：${opening}`)) : null

  // ---- 八、侧栏上的会话操作：改名、删除（用的是刚建的那个会话）----
  const rowOf = (title: string) =>
    all('.ss-row').find((element) => element.textContent?.includes(title))
  /** “已归档对话”那一页里的一行 */
  const shelvedOf = (title: string) =>
    all('.arch-item').find((element) => element.textContent?.includes(title))
  /** 点开某一行的菜单，选那一项（按 data-action，不按文案） */
  const act = async (row: string, action: 'rename' | 'archive' | 'delete') => {
    rowOf(row)?.parentElement?.querySelector<HTMLButtonElement>('.row-more > .ibtn')?.click()
    const item = await until(`菜单项“${action}”`, () =>
      one<HTMLButtonElement>(`.row-more .pick-opt[data-action="${action}"]`),
    )
    item.click()
    await frame()
  }
  const newName = '改过名的会话'
  await act(opening, 'rename')
  const nameField = await until('改名的输入框', () => one<HTMLInputElement>('.ss-name'))
  await frame()
  const nameFocused = document.activeElement === nameField
  write(nameField, newName)
  await frame()
  press(nameField, 'Enter')
  await until('侧栏上的新名字', () => rowOf(newName))
  const renamed = nameFocused && Boolean(one('.crumb')?.textContent?.includes(newName))

  await act(newName, 'archive')
  await until('归档的那一行从列表里消失', () => !rowOf(newName))
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进已归档对话的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="archived"]'),
    )
  ).click()
  const shelved = await until('已归档对话里的这个会话', () => shelvedOf(newName))
  const archived =
    !one('.sb-scroll')?.textContent?.includes(newName) &&
    Boolean(one('.crumb')?.textContent?.includes('已归档对话'))
  const restore = [...shelved.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('恢复'),
  )
  restore?.click()
  const restoredRow = await until('恢复的会话回到侧栏里', () => rowOf(newName))
  await until('已归档对话里不再有它', () => !shelvedOf(newName))
  restoredRow.click()
  await until('恢复的会话的内容', () => users().includes(opening))
  const restored = !one('.arch-page') && Boolean(one('.crumb')?.textContent?.includes(newName))

  await act(newName, 'delete')
  const deleteAsked = Boolean(one('.row-more .pick-ask')) && Boolean(rowOf(newName))
  one<HTMLButtonElement>('.row-more .pick-ask .btn.danger')?.click()
  await until('删掉的那一行消失', () => !rowOf(newName))
  const deletedHome = Boolean(
    await until('回到新建对话页', () => one('.new-hero') && !one('.ss-row.sel') && !one('.turn')),
  )

  // ---- 输入历史、上下文占用 ----
  await open(main)
  const typing = await until('输入框', area)
  if (typing.value) write(typing, '')
  await frame()
  // 连着发了两遍一样的只算一条；只有图没有字的不算
  const said = users().filter((entry, index, list) => entry && entry !== list[index - 1])
  typing.focus()
  typing.setSelectionRange(0, 0)
  press(typing, 'ArrowUp')
  await frame()
  const newest = typing.value
  press(typing, 'ArrowUp')
  await frame()
  const older = typing.value
  press(typing, 'ArrowDown')
  await frame()
  press(typing, 'ArrowDown')
  await frame()
  const historyRecalled =
    said.length >= 2 && newest === said.at(-1) && older === said.at(-2) && typing.value === ''
  const contextShown = /^\d+%$/.test(one('.cmp-bar .ctx')?.textContent ?? '')

  // ---- 九、请求卡片：焦点、快捷键、分页 ----
  let cards: ComposeProbe['cards'] = null
  let skins: ComposeProbe['wizardSkins'] = null
  if (!real) {
    await open('聚合面')
    const firstCard = await until('审批卡片', () => one<HTMLElement>('.req'))
    await frame()
    const approvalFocus = document.activeElement === firstCard
    await open(main)
    const marked = Boolean(
      all('.ss-row')
        .find((element) => element.textContent?.includes('聚合面'))
        ?.querySelector('.pill.wait'),
    )
    await open('聚合面')
    const approval = await until('切回来之后的审批卡片', () => one<HTMLElement>('.req'))
    await frame()
    const keptAway = marked && document.activeElement === approval
    const row = all('.ss-row')[0]
    row?.focus()
    if (row) press(row, 'Enter')
    await sleep(200)
    const strayEnterIgnored = document.activeElement === row && one('.req') === approval
    approval.focus()
    press(approval, 'Escape')
    const toolCard = await until('排在后面的工具调用审批', () => {
      const card = one<HTMLElement>('.req')
      return card && card !== approval && card.textContent?.includes('tracker') ? card : null
    })
    await frame()
    const declined = !approval.isConnected
    const toolAsked = document.activeElement === toolCard && all('.req-actions .btn').length === 5
    press(toolCard, 'Enter')
    await until('审批卡片消失', () => !one('.req'))
    await frame()
    // 输入框一直都在（请求不挡它）；卡片没了，原来在卡片上的焦点回到它那里
    const toolAccepted = Boolean(area()) && document.activeElement === area()

    // ---- 提问向导。第一轮：示例里那张三道题的卡片（单选、自己写、单选） ----
    const wizard = {
      card: () => (one('.step') ? one<HTMLElement>('.req') : null),
      /** 各题的标记现在是什么状态 */
      marks: () =>
        all('.step')
          .map((step) => step.dataset.state ?? '')
          .join(','),
      /** 翻到第几题，从 0 数 */
      page: () => all('.step').findIndex((step) => step.getAttribute('aria-current') === 'step'),
      title: () => one('.req-q')?.textContent ?? '',
      /** 选中的是第几个选项，-1 是都没选 */
      checked: () =>
        all('.opt').findIndex((option) => option.getAttribute('aria-checked') === 'true'),
      label: (index: number) => all('.opt')[index]?.querySelector('.tx b')?.textContent ?? '',
      field: () => one<HTMLInputElement>('.req input.req-input'),
      act: (name: string) => one<HTMLButtonElement>(`.req [data-act="${name}"]`),
      note: () => one('.req-hint.err')?.textContent ?? '',
    }
    /** 等翻到第几题，再等焦点安排好 */
    const onPage = async (index: number) => {
      await until(`翻到第 ${index + 1} 题`, () => wizard.page() === index)
      await frame()
      await frame()
    }
    const toPage = async (index: number) => {
      all('.step')[index]?.click()
      await onPage(index)
    }
    /** 回合结束之后，最后那条回话里有没有这几行。模拟核心把收到的回答一题一行带在回话前面 */
    const heard = async (lines: string[]) => {
      const last = () => all('.turn').at(-1)?.textContent ?? ''
      await until('带着回答的回话', () => last().includes('收到你的回答') && !running())
      const end = performance.now() + 3000
      while (performance.now() < end) {
        if (lines.every((line) => last().includes(line))) return true
        await sleep(50)
      }
      return false
    }

    await open('Linux 安装包')
    const ask = await until('提问卡片', wizard.card)
    await frame()
    const titles = [wizard.title()]
    const picks = ['', '', '']
    const wizardShown =
      Boolean(one('.req-head')?.textContent?.includes('第 1 题，共 3 题')) &&
      wizard.marks() === 'open,open,open' &&
      wizard.page() === 0 &&
      wizard.act('back')?.disabled === true &&
      wizard.act('next')?.disabled === false &&
      document.activeElement === ask

    const aside = all('.ss-row')[0]
    aside?.focus()
    if (aside) {
      press(aside, 'ArrowRight')
      press(aside, '1')
    }
    await sleep(300)
    const strayKeysIgnored =
      document.activeElement === aside && wizard.page() === 0 && wizard.checked() === -1
    ask.focus()

    // 没答也能翻
    press(ask, 'ArrowRight')
    await onPage(1)
    titles.push(wizard.title())
    const typed = await until('第二题的输入框', wizard.field)
    const typedFocus = document.activeElement === typed && all('.opt').length === 0
    press(typed, 'ArrowLeft')
    await sleep(120)
    const caretKept = wizard.page() === 1
    picks[1] = 'litch-agent'
    write(typed, picks[1])
    await frame()
    press(typed, 'Enter')
    await onPage(2)
    titles.push(wizard.title())
    const flipped =
      typedFocus &&
      caretKept &&
      wizard.marks() === 'open,answered,open' &&
      wizard.act('next')?.disabled === true &&
      document.activeElement === ask

    // 最后一题按数字键选了，可第一题还没答
    picks[2] = wizard.label(0)
    press(ask, '1')
    await onPage(0)
    const lastGated =
      wizard.card() === ask &&
      wizard.note().includes('第 1 题') &&
      wizard.marks() === 'open,answered,answered'

    // 点选项：选中，过一小会儿自己到下一题
    const pickedAt = performance.now()
    all('.opt')[1]?.click()
    await frame()
    const shownChecked = wizard.checked() === 1 && wizard.page() === 0
    await onPage(1)
    const advanceMs = performance.now() - pickedAt
    const autoAdvanced =
      shownChecked &&
      advanceMs >= 150 &&
      advanceMs < 1500 &&
      !wizard.note() &&
      wizard.field()?.value === picks[1] &&
      document.activeElement === wizard.field()

    // 往回翻：之前选的还选着。改了答案照常到下一题——这时三道题都答过了，也不交卷
    wizard.act('back')?.click()
    await onPage(0)
    const stillChecked = wizard.checked() === 1 && document.activeElement === ask
    press(ask, '1')
    await onPage(1)
    await sleep(400)
    const changedAdvances = stillChecked && wizard.page() === 1 && wizard.card() === ask

    // 选完没等它前进又动了：连着点两个选项算后一个、只前进一步；选完马上自己翻了题，定时的前进不再执行
    await toPage(0)
    const rewritten = wizard.checked() === 0
    all('.opt')[0]?.click()
    all('.opt')[1]?.click()
    await onPage(1)
    await sleep(400)
    const onceOnly = wizard.page() === 1
    await toPage(0)
    const latterKept = wizard.checked() === 1
    press(ask, '1')
    press(ask, 'ArrowRight')
    await onPage(1)
    await sleep(400)
    const lastWins = rewritten && onceOnly && latterKept && wizard.page() === 1

    // 选完没等它前进就切走：回来还在这一题，不会替人翻走；各题填的都在
    await toPage(0)
    const flippedKept = wizard.checked() === 0
    picks[0] = wizard.label(1)
    press(ask, '2')
    await open(main)
    await sleep(400)
    await open('Linux 安装包')
    const again = await until('切回来之后的提问卡片', wizard.card)
    await frame()
    await frame()
    const cameBack =
      wizard.page() === 0 &&
      wizard.checked() === 1 &&
      wizard.marks() === 'answered,answered,answered'
    await toPage(1)
    const draftKept = flippedKept && cameBack && wizard.field()?.value === picks[1]

    // 上下箭头在选项间移动，不自己前进
    await toPage(2)
    const before = wizard.checked()
    press(again, 'ArrowDown')
    await sleep(400)
    const movedOnly = before === 0 && wizard.checked() === 1 && wizard.page() === 2
    // 过了最后一项进“其他”
    press(again, 'ArrowDown')
    const custom = await until('“其他”的输入框', wizard.field)
    await frame()
    await frame()
    const otherFocused =
      document.activeElement === custom &&
      all('.opt').at(-1)?.getAttribute('aria-checked') === 'true'
    press(custom, 'ArrowUp')
    await until('回到选项里', () => !wizard.field())
    await frame()
    await frame()
    const backInOptions =
      wizard.checked() === all('.opt').length - 2 && document.activeElement === again
    press(again, 'ArrowLeft')
    await onPage(1)
    const arrowsMoved = movedOnly && otherFocused && backInOptions

    // 最后一题点了选项，每道题都有了说法：直接交卷
    await toPage(2)
    all('.opt')[0]?.click()
    const form = await until('排在后面的表单', () =>
      one<HTMLElement>('.req-form')?.closest<HTMLElement>('.req'),
    )
    await frame()
    const formFocused = document.activeElement?.classList.contains('req-input') === true
    press(form, 'Enter')
    const formChecked =
      Boolean(await until('没填必填项的说明', () => one('.form-note.err'))) &&
      Boolean(one('.req-form'))
    all('.pickset-opt')[0]?.click()
    await frame()
    const bounded = one<HTMLInputElement>('.req-form input.req-input')
    const rangeShown = one('.req-form [data-range]')?.textContent === '1 到 20'
    if (bounded) write(bounded, '99')
    await frame()
    press(form, 'Enter')
    const outOfRange = await until('出界的说明', () => one('.form-note.err'))
    const formBounded =
      rangeShown && Boolean(outOfRange.textContent?.includes('不能大于 20')) && form.isConnected
    if (bounded) write(bounded, '3')
    await frame()
    press(form, 'Enter')
    await until('表单卡片消失', () => !one('.req'))
    const answersMatched = await heard(titles.map((title, index) => `${title} → ${picks[index]}`))

    // ---- 第二轮：话里带“提问”再问一次。跳过、交卷时有没答的、回车交卷 ----
    await say('再提问一次')
    const second = await until('第二轮的提问卡片', wizard.card)
    await frame()
    wizard.act('skip')?.click()
    await onPage(1)
    const skipMarked = wizard.marks() === 'skipped,open,open'
    await toPage(2)
    press(second, 'ArrowDown')
    await frame()
    const lastPick = wizard.label(0)
    wizard.act('submit')?.click()
    await onPage(1)
    const submitGated =
      wizard.card() === second &&
      wizard.note().includes('第 2 题') &&
      wizard.marks() === 'skipped,open,answered'

    // 这时三种标记都有：跳过的、没答的（当前这道，带着说明）、答了的。换着皮肤和明暗量一遍
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const paint = canvas.getContext('2d', { willReadFrequently: true })
    /** 几层颜色从底到顶叠起来，实际看到的是什么颜色。半透明的、混出来的颜色都照浏览器的算法来 */
    const flat = (...layers: string[]) => {
      if (!paint) return [0, 0, 0]
      paint.clearRect(0, 0, 1, 1)
      for (const layer of layers) {
        paint.fillStyle = layer
        paint.fillRect(0, 0, 1, 1)
      }
      return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const rgb = (color: number[]) => `rgb(${color.join(',')})`
    const luminance = (color: number[]) => {
      const [r = 0, g = 0, b = 0] = color.map((part) => {
        const channel = part / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a: number[], b: number[]) => {
      const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const look = (selector: string) => {
      const found = one(selector)
      if (!found) throw new Error(`量颜色时找不到：${selector}`)
      return getComputedStyle(found)
    }
    /** 卡片里的东西都在卡片里面，卡片在窗口里面 */
    const fits = () => {
      const card = one('.req')
      if (!card) return false
      const box = card.getBoundingClientRect()
      const inside = [
        ...card.querySelectorAll(
          '.req-head, .req-steps, .req-q, .req-body, .req-hint, .req-actions',
        ),
        ...card.querySelectorAll('.step, .opt, .btn, .req-input'),
      ].every((part) => {
        const rect = part.getBoundingClientRect()
        return (
          rect.left >= box.left - 0.5 &&
          rect.right <= box.right + 0.5 &&
          rect.top >= box.top - 0.5 &&
          rect.bottom <= box.bottom + 0.5 &&
          part.scrollWidth <= part.clientWidth + 1
        )
      })
      return (
        inside &&
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight
      )
    }
    // 换皮肤、明暗走界面给验收留的口子（window.__litchLook），不直接改根元素上的属性
    const appearance = (
      window as unknown as {
        __litchLook: {
          get(): { skin: string; theme: string }
          set(patch: { skin?: string; theme?: string }): void
        }
      }
    ).__litchLook
    const was = appearance.get()
    const wizardSkins: string[] = []
    for (const skin of ['retro', 'human', 'standard']) {
      for (const theme of ['light', 'dark']) {
        appearance.set({ skin, theme })
        // 交卷被挡回来的那一刻：没答的说明只在这时有
        wizard.act('submit')?.click()
        await onPage(1)
        const ground = flat(look('body').backgroundColor, look('.req').backgroundColor)
        /** 直接写在卡片上的字，和卡片的底差多少 */
        const on = (selector: string) => contrast(flat(rgb(ground), look(selector).color), ground)
        const numbers = [
          on('.req-q'),
          on('.req-head span'),
          on('.req-hint.err'),
          on('.step[data-state="open"]'),
        ]
        const done = look('.step[data-state="answered"]')
        const block = flat(rgb(ground), done.backgroundColor)
        numbers.push(contrast(flat(rgb(block), done.color), block), contrast(block, ground))
        numbers.push(on('.step[data-state="skipped"]'))
        let fit = fits()
        // 跳过的那道题：底下写着跳过了
        await toPage(0)
        numbers.push(on('.req-hint'))
        fit = fit && fits()
        // 答了的那道题：选中的选项
        await toPage(2)
        const chosen = flat(rgb(ground), look('.opt[aria-checked="true"]').backgroundColor)
        numbers.push(
          contrast(flat(rgb(chosen), look('.opt[aria-checked="true"] .tx b').color), chosen),
          contrast(flat(rgb(chosen), look('.opt[aria-checked="true"] .tx span').color), chosen),
        )
        fit = fit && fits()
        wizardSkins.push(
          `${skin}/${theme}:${numbers.map((value) => value.toFixed(1)).join(':')}:${fit ? '放得下' : '放不下'}`,
        )
      }
    }
    appearance.set({ skin: was.skin, theme: was.theme })
    await frame()

    // 翻回去看跳过的那道：写着跳过了
    await toPage(0)
    const skipped = skipMarked && Boolean(one('.req-hint:not(.err)'))
    press(second, 'ArrowRight')
    await onPage(1)
    wizard.act('skip')?.click()
    await onPage(2)
    // 最后一题上按回车：交卷
    press(second, 'Enter')
    await until('提问卡片消失', () => !one('.req'))
    const skippedSent = await heard([
      `${titles[0]} → （跳过）`,
      `${titles[1]} → （跳过）`,
      `${titles[2]} → ${lastPick}`,
    ])

    // ---- 第三轮：话里带“问一句”，只有一道题：没有翻题的那些东西，选了就交 ----
    await say('问一句就行')
    const single = await until('只有一道题的提问卡片', () =>
      all('.opt').length ? one<HTMLElement>('.req') : null,
    )
    await frame()
    const onlyTitle = wizard.title()
    const onlyPick = wizard.label(1)
    const plain =
      !one('.step') &&
      !wizard.act('back') &&
      !wizard.act('next') &&
      all('.opt').length === 2 &&
      !one('.req-head')?.textContent?.includes('共') &&
      document.activeElement === single
    press(single, '2')
    await until('提问卡片消失', () => !one('.req'))
    const singleAuto = plain && (await heard([`${onlyTitle} → ${onlyPick}`]))

    skins = wizardSkins
    cards = {
      approvalFocus,
      keptAway,
      strayEnterIgnored,
      declined,
      toolAsked,
      toolAccepted,
      wizardShown,
      strayKeysIgnored,
      flipped,
      lastGated,
      autoAdvanced,
      changedAdvances,
      lastWins,
      draftKept,
      arrowsMoved,
      autoSubmitted: true,
      answersMatched,
      skipped,
      submitGated,
      skippedSent,
      singleAuto,
      formFocused,
      formChecked,
      formBounded,
      formSent: true,
    }
  }

  // ---- 十、引擎真的发来的提问：两问一先一后，答完回话里带着这两个回答 ----
  let asked: ComposeProbe['asked'] = null
  if (real) {
    await open(main)
    const reply = watchAnswers()
    await say('问我两个问题')
    const choose = await until('引擎发来的提问卡片', () =>
      all('.opt').length ? one('.req') : null,
    )
    await frame()
    const shown = document.activeElement === choose && all('.opt').length === 3 && !one('.step')
    // 侧栏的记号和提问卡片走的是两条订阅，各按各的帧送到界面，谁先到不一定：卡片先到的那一帧里
    // 记号还没画出来。卡片这时一直开着，等记号出现再往下走，不在卡片刚出现的那一帧就下结论。
    const marked = await until(
      '侧栏上“待回答”的记号',
      () => one('.ss-row.sel .pill.wait'),
      5000,
    ).then(
      () => true,
      () => false,
    )
    // 一次只来一道题的请求：选了就交，不用再按回车
    press(choose, '2')
    await until('第二个选项被选中', () => all('.opt')[1]?.getAttribute('aria-checked') === 'true')
    // 第二问没有选项，只能自己写
    const custom = await until('第二问的输入框', () =>
      all('.opt').length ? null : one<HTMLInputElement>('.req-input'),
    )
    await frame()
    const typedFocus = document.activeElement === custom
    write(custom, '别动数据库')
    await frame()
    press(custom, 'Enter')
    await until('提问卡片消失', () => !one('.req'))
    await until('带着两个回答的回话', () => {
      const text = all('.turn').at(-1)?.textContent ?? ''
      return text.includes('只改适配器') && text.includes('别动数据库') && !running()
    })
    // 等这条回话定稿、匀速放出来的字也放完
    await sleep(600)
    const told = reply.stop()
    asked = {
      shown,
      typedFocus,
      marked,
      answered: document.activeElement === area(),
      clean: told.stray.length === 0 && !told.repeated && told.shapes >= 2,
    }
  }

  return {
    imeKept,
    bubbleMs,
    streamSteps,
    streamStray: streamed.stray,
    streamShapes: streamed.shapes,
    streamRepeated: streamed.repeated,
    order,
    queuedMax,
    echoed,
    steered,
    interrupted,
    steerSettled,
    draftIsolated,
    draftKept,
    reopenSame,
    reopenDiff,
    imagePasted,
    imageRefusedOther,
    imageDraftKept,
    imageShown,
    imageViewed,
    imageKept,
    imageDelivered,
    modelShown,
    effortFollowsModel,
    effortDefault,
    modelSearch,
    riskAsked,
    riskSwitched,
    newBubbleMs,
    newLanded,
    newEchoed,
    renamed,
    archived,
    restored,
    deleteAsked,
    deletedHome,
    historyRecalled,
    contextShown,
    cards,
    wizardSkins: skins,
    folded,
    asked,
  }
}

/** 哪些项不合格。全过就是空的 */
export function judgeCompose(probe: ComposeProbe): string[] {
  const failed: string[] = []
  if (!probe.imeKept) failed.push('输入法选词时的回车把消息发出去了')
  if (!(probe.bubbleMs < 300))
    failed.push(`发出去的消息过了 ${Math.round(probe.bubbleMs)} 毫秒才出现`)
  if (!(probe.streamSteps >= 2))
    failed.push(`回话不是一段一段到的（变长了 ${probe.streamSteps} 次）`)
  if (probe.streamStray.length > 0)
    failed.push(
      `流式输出时显示过不是最终文字开头的内容：${probe.streamStray.slice(0, 3).join(' ｜ ')}`,
    )
  if (!(probe.streamShapes >= 8))
    failed.push(`没有量到流式输出的过程（四条回答一共只看到 ${probe.streamShapes} 种样子）`)
  if (probe.streamRepeated) failed.push('定稿之后的回答里，开头那几个字又出现了一遍')
  if (probe.order.join('|') !== '第一条|第二条|第三条|第四条')
    failed.push(`排队的消息顺序不对：${probe.order.join('、')}`)
  if (probe.queuedMax !== 3) failed.push(`托盘里最多同时有 ${probe.queuedMax} 条，应该是 3 条`)
  if (probe.echoed === false) failed.push('有回话没有对上发出去的那一句')
  if (!probe.steered) failed.push('排着的消息没有插进正在进行的回合')
  if (!probe.interrupted) failed.push('点了停止，回合没有标成已中断')
  if (!probe.steerSettled) failed.push('插进去的话在打断之后没了，或者出现了两遍')
  if (!probe.draftIsolated) failed.push('草稿串到别的会话里去了')
  if (!probe.draftKept) failed.push('切回来之后草稿没了')
  if (!probe.reopenSame) failed.push('切走再回来，对话里的用户消息变了')
  if (!probe.imagePasted) failed.push('贴图片的时候文件名被当成文字贴进了输入框')
  if (!probe.imageRefusedOther) failed.push('带不了的文件没有被挡下来')
  if (!probe.imageDraftKept) failed.push('带图的草稿串到了别的会话，或者切回来没了')
  if (!probe.imageShown)
    failed.push('发出去的图片没有显示成固定大小的缩略图，或者输入区里的图没清掉')
  if (!probe.imageViewed) failed.push('缩略图点开看不到大图')
  if (!probe.imageKept) failed.push('回合结束之后消息里的图片没了')
  if (probe.imageDelivered === false) failed.push('图片没有送到模型手里')
  if (!probe.modelShown) failed.push('底栏上没有显示当前的模型')
  if (probe.effortFollowsModel === false) failed.push('强度的选择器没有跟着模型变')
  // 模拟的 codex 默认模型是 GPT-5.5 Codex，它默认的那一档是“中”
  if (probe.effortDefault !== null && probe.effortDefault !== '中')
    failed.push(
      `原生 codex 没配强度时底栏的强度应显示模型默认的“中”，显示的是“${probe.effortDefault}”`,
    )
  if (
    probe.modelSearch !== null &&
    probe.modelSearch !== '框里｜GPT-5.5 mini、GPT-5.4 mini、o5 mini｜GPT-5.5 mini'
  )
    failed.push(`模型选择器的筛选框不对（焦点｜筛完剩下的｜回车之后）：${probe.modelSearch}`)
  if (probe.riskAsked === false) failed.push('高风险的权限预设没有先问一句就换过去了')
  if (probe.riskSwitched === false) failed.push('确认之后权限预设没有换过去')
  if (!(probe.newBubbleMs < 300))
    failed.push(`新建会话的第一条消息过了 ${Math.round(probe.newBubbleMs)} 毫秒才出现`)
  if (!probe.newLanded) failed.push('新会话建好之后没有落在它里面')
  if (probe.newEchoed === false) failed.push('新会话的第一条回话没有对上')
  if (!probe.renamed) failed.push('会话改名没有生效，或者输入框没有拿到焦点')
  if (!probe.archived) failed.push('归档之后会话还在侧栏里，或者“已归档对话”里没有它')
  if (!probe.restored) failed.push('在“已归档对话”里恢复的会话没有回到侧栏里')
  if (!probe.deleteAsked) failed.push('删除会话没有先问一句')
  if (!probe.deletedHome) failed.push('会话删掉之后没有回到新建对话页')
  if (!probe.historyRecalled) failed.push('上下箭头没有翻出这个会话里发过的话')
  if (!probe.contextShown) failed.push('底栏上没有上下文占用')
  for (const [name, ok] of Object.entries(probe.cards ?? {})) {
    if (!ok) failed.push(`请求卡片：${name} 不对`)
  }
  // 向导在各种皮肤下：要读的字（题目、说明、选项、标记上的数）不低于 4.5；
  // 跳过的标记是划掉的淡字，不低于 3；答了的标记是实心的一块，和卡片分得开
  const floors = [4.5, 4.5, 4.5, 4.5, 4.5, 1.5, 3, 4.5, 4.5, 4.5]
  for (const line of probe.wizardSkins ?? []) {
    const [where, ...parts] = line.split(':')
    const fit = parts.pop()
    const low = parts.some((part, index) => !(Number(part) >= (floors[index] ?? 4.5)))
    if (parts.length !== floors.length || low)
      failed.push(`提问向导在 ${where} 下有字看不清：${parts.join('、')}`)
    if (fit !== '放得下') failed.push(`提问向导在 ${where} 下放不下`)
  }
  if (probe.wizardSkins && probe.wizardSkins.length !== 6)
    failed.push(`提问向导的皮肤没有量全：${probe.wizardSkins.length}`)
  for (const [name, ok] of Object.entries(probe.folded ?? {})) {
    if (!ok) failed.push(`会话多的项目：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.asked ?? {})) {
    if (!ok) failed.push(`引擎发来的提问：${name} 不对`)
  }
  return failed
}
