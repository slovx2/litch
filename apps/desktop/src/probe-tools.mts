// 工具调用的结果很大时的验收，只对着模拟核心（接在 client:check:scroll 的长输出后面）：
// 发“工具大结果”，模拟核心里先后调两次工具：一次 MCP 工具回 20 MB 上下的文字夹一张 2 MB 的图，
// 一次动态工具回三千段文字和三千张小图（样子在 packages/core/src/mock/sample-tools.mts，经真的投影截）。
// 回合结束之后逐个点开看结果那一框：框里有多少字、图片有几行说明（都要有上限）、中间省掉的地方标出来没有、
// 头尾是不是最前和最后那几段；点开之后那几帧的帧间隔只报数。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

/** 一次工具调用点开之后量到的 */
export interface ToolSeen {
  /** 结果那一框里的字数（文字段的文字节点加起来，省略记号和图片的说明不算） */
  chars: number
  /** 结果那一框里图片、音频这类说明有几行 */
  blobs: number
  /** 图片说明的头一行写的字。没有是 null */
  blobText: string | null
  /** 省略记号上写的字。没有记号是 null */
  gapText: string | null
  /** 结果那一框里第一行、最后一行文字 */
  firstLine: string
  lastLine: string
  /** 点开之后 40 帧里最长的帧间隔（毫秒）：头一帧要把这一框排出来 */
  openMs: number
}

export interface ToolsProbe {
  dump: ToolSeen
  shots: ToolSeen
  /** 两次调用都在时限之内完成、回合走到了结束 */
  completed: boolean
  /** 页面的 JS 堆（MB）：发消息之前、看完之后。浏览器给不了是 null */
  heapBefore: number | null
  heapAfter: number | null
}

export async function toolsProbe(): Promise<ToolsProbe> {
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
      await frame()
    }
    throw new Error(`工具大结果：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const heap = () => {
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
    return memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : null
  }

  const row = await until('侧栏里的“远程设备安装指引”', () =>
    all('.ss-row').find((entry) => text(entry).includes('远程设备安装指引')),
  )
  row.click()
  await until('会话的内容', () => text(one('.crumb')).includes('远程设备安装指引') && area())
  await until('上一轮结束', () => !running() && !one('.req') && area(), 120_000)
  const heapBefore = heap()
  const input = await until('输入框', area)
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    input,
    '工具大结果',
  )
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await frame()
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )

  const lastTurn = () => all('.turn').at(-1) ?? null
  await until('这一轮开始', running, 10_000)
  // 两次调用都完成、回话也说完：整段过程这时已经自己收起来了
  const completed = await until('这一轮结束', () => !running() && area(), 60_000).then(
    () => true,
    () => false,
  )
  // 收起的过程点开，再把里面的步骤组都点开（回合没结束时没有收起的那一行，过程本来就摊着）
  const proc = one<HTMLButtonElement>('.proc-head', lastTurn() ?? undefined)
  if (proc && proc.getAttribute('aria-expanded') !== 'true') proc.click()
  const groups = await until('步骤组', () => {
    const found = all('.steps-head', lastTurn() ?? undefined)
    return found.length > 0 ? found : null
  })
  for (const group of groups) if (group.getAttribute('aria-expanded') !== 'true') group.click()
  await until('步骤组开着', () =>
    all('.steps-head', lastTurn() ?? undefined).every(
      (group) => group.getAttribute('aria-expanded') === 'true',
    ),
  )

  /** 框里文字段的文字节点：不拼整段，免得量的这一下本身随结果涨 */
  const textNodes = (root: Element) => {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest('.well-gap, .well-blob')) nodes.push(node as Text)
    }
    return nodes
  }

  const look = async (target: string): Promise<ToolSeen> => {
    const head = await until(`“${target}”那一行`, () =>
      all('.item-head', lastTurn() ?? undefined).find(
        (entry) => text(one('.tgt', entry)) === target,
      ),
    )
    const item = head.closest('.item') ?? document.body
    let last = performance.now()
    head.click()
    let openMs = 0
    for (let index = 0; index < 40; index++) {
      await frame()
      const now = performance.now()
      openMs = Math.max(openMs, now - last)
      last = now
    }
    // 结果那一框：标签是“结果”的那一块（参数另有一框）
    const io = await until('结果那一框', () =>
      all('.item-detail .io', item).find((entry) => text(one('.io-label', entry)) === '结果'),
    )
    const box = one('.well', io) ?? io
    const nodes = textNodes(box)
    const chars = nodes.reduce((sum, node) => sum + node.length, 0)
    const blobs = all('.well-blob', box)
    const firstLine = (nodes[0]?.data ?? '').split('\n', 1)[0] ?? ''
    const lastLine = (nodes.at(-1)?.data ?? '').replace(/\n+$/, '').split('\n').at(-1) ?? ''
    const seen = {
      chars,
      blobs: blobs.length,
      blobText: blobs[0] ? text(blobs[0]) : null,
      gapText: text(one('.well-gap', box)) || null,
      firstLine,
      lastLine,
      openMs: Math.round(openMs),
    }
    head.click()
    await frame()
    return seen
  }

  const dump = await look('db · dump_table')
  const shots = await look('browser · capture_frames')
  return { dump, shots, completed, heapBefore, heapAfter: heap() }
}

/** 合不合格：只判和机器快慢无关的几样。帧间隔、内存只报数 */
export function judgeTools(probe: ToolsProbe, limits: { chars: number; blobs: number }): string[] {
  const failed: string[] = []
  if (!probe.completed) failed.push('工具大结果：两次调用之后回合没在时限之内走到结束')
  for (const [name, seen] of [
    ['MCP 导出', probe.dump],
    ['动态工具截图', probe.shots],
  ] as const) {
    if (!(seen.chars <= limits.chars))
      failed.push(`工具大结果：${name}的结果框里有 ${seen.chars} 个字，上限 ${limits.chars}`)
    if (!(seen.blobs <= limits.blobs))
      failed.push(`工具大结果：${name}的结果框里有 ${seen.blobs} 行图片说明，上限 ${limits.blobs}`)
    if (!seen.gapText?.includes('省略'))
      failed.push(`工具大结果：${name}中间省掉的地方没有标出来（记号上是“${seen.gapText ?? ''}”）`)
  }
  const { dump, shots } = probe
  if (!dump.firstLine.startsWith('[0000001] event #1 '))
    failed.push(`工具大结果：导出的第一行不是最前那一行（“${dump.firstLine}”）`)
  if (dump.lastLine !== '-- end of dump --')
    failed.push(`工具大结果：导出的最后一段不是结语（“${dump.lastLine}”）`)
  if (dump.blobs !== 1 || !dump.blobText?.startsWith('图片 · image/png · 1.5 MB'))
    failed.push(`工具大结果：导出里那张图没有写成一行说明（${dump.blobs} 行，“${dump.blobText}”）`)
  if (shots.firstLine !== 'frame 1' || shots.lastLine !== 'frame 3000')
    failed.push(`工具大结果：截图的头尾不对（“${shots.firstLine}” … “${shots.lastLine}”）`)
  if (!shots.gapText?.includes('段图片'))
    failed.push(`工具大结果：截图中间省掉的图片没有记段数（“${shots.gapText ?? ''}”）`)
  return failed
}
