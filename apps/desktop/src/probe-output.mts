// 命令输出很长时的验收，只对着模拟核心（接在 client:check:scroll 的滚动验收后面）：
// 发“狂打日志”，模拟核心里的一条命令按真的时间狂打 24 MB 日志（每一拍几段，一段 8 KB）；
// 再发“猛打日志”量一遍，同一条命令打得快八倍（一拍 512 KB，一秒上下打完），这时通道只给界面发头尾。
// 展开着那条命令看它打完：每一帧量那一框里有多少字（要不随输出涨）、框是不是一直贴着底；
// 打完之后看头尾留的是不是最前和最后那几行、中间省掉的地方标出来没有、切在不在行与行之间。
// expand 给 false 就一直收着不看（手工量“没人看时”的内存用，验收里不这么跑）。
// 帧间隔和页面的 JS 堆只报数，不判：它们看机器忙闲。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface OutputProbe {
  /** 狂打期间（命令还在转）取样了几帧 */
  frames: number
  /** 这几帧里那一框中最多有多少个字（各个文字节点的长度加起来，不读整段文字） */
  maxShownChars: number
  /** 打完之后那一框里有多少个字 */
  finalChars: number
  /** 帧间隔：中位、p95、最大（毫秒）；超过 100 毫秒的有几帧 */
  frameMs: { median: number; p95: number; max: number; over100: number }
  /** 狂打期间那一框离底最远多少像素（贴着底应为 0） */
  maxOffBottom: number
  /** 命令在时限之内打完了 */
  completed: boolean
  /** 打完之后省略记号上写的字。没有记号是 null */
  gapText: string | null
  /** 省略记号前面那一截的最后几十个字、后面那一截的最前几十个字（看切的地方是不是在行与行之间） */
  beforeGap: string
  afterGap: string
  /** 打完之后那一框里第一行、最后一行 */
  firstLine: string
  lastLine: string
  /** 页面的 JS 堆（MB）：狂打之前、打完之后。浏览器给不了是 null */
  heapBefore: number | null
  heapAfter: number | null
}

export async function outputProbe(expand = true, say = '狂打日志'): Promise<OutputProbe> {
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
    throw new Error(`长输出：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 120_000)
  const heap = () => {
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
    return memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : null
  }
  const COMMAND = 'npm run build -- --verbose'

  const row = await until('侧栏里的“远程设备安装指引”', () =>
    all('.ss-row').find((entry) => text(entry).includes('远程设备安装指引')),
  )
  row.click()
  await until('会话的内容', () => text(one('.crumb')).includes('远程设备安装指引') && area())
  await idle()
  const heapBefore = heap()
  // 发出去之后新的一轮要过一会儿才画出来；这之前“最后一轮”还是上一轮，猛打紧跟在狂打后面，
  // 上一轮里有同一条命令，会被当成这一条点开。所以先记下有几轮，等多出一轮再找
  const turnsBefore = all('.turn').length
  const input = await until('输入框', area)
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, say)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await frame()
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )

  const lastTurn = () => all('.turn').at(-1) ?? null
  const head = () =>
    all('.item-head', lastTurn() ?? undefined).find(
      (entry) => text(one('.tgt', entry)) === COMMAND,
    ) as HTMLButtonElement | undefined
  await until('新的一轮', () => all('.turn').length > turnsBefore)
  await until('那条狂打日志的命令', head)
  // 活动块在回合进行中是开着的，最终回答一开始就会自己收起来；用户点过的以用户的为准。
  // 打完之后还要看框里的样子，所以先替用户点一下“开着”：开着的先收再开
  const act = await until('活动块', () =>
    one<HTMLButtonElement>('.act-head', lastTurn() ?? undefined),
  )
  if (act.getAttribute('aria-expanded') === 'true') {
    act.click()
    await frame()
  }
  act.click()
  await until('活动块开着', () => act.getAttribute('aria-expanded') === 'true')
  // 还没有输出的命令那一行点不开，等头一段输出到了再点
  const ready = await until('那条命令有了输出', () => (head()?.disabled === false ? head() : null))
  const well = () => one('.item-detail .well', head()?.closest('.item') ?? undefined)
  if (expand) {
    ready.click()
    await until('展开的输出框', well)
  }

  /** 框里各个文字节点的长度加起来：不拼整段文字，免得量的这一下本身随输出涨 */
  const shown = (root: Element | null) => {
    if (!root) return 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let total = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      total += (node as Text).length
    }
    return total
  }
  const spinning = () => Boolean(one('.st.run', head() ?? undefined))
  const gaps: number[] = []
  let maxShownChars = 0
  let maxOffBottom = 0
  let frames = 0
  let last = performance.now()
  const deadline = last + 45_000
  while (spinning() && performance.now() < deadline) {
    await frame()
    const now = performance.now()
    gaps.push(now - last)
    last = now
    frames++
    const box = well()
    maxShownChars = Math.max(maxShownChars, shown(box))
    // 反向列的滚动框：贴着底时 scrollTop 是 0，往上翻是负的
    maxOffBottom = Math.max(maxOffBottom, Math.abs(box?.scrollTop ?? 0))
  }
  const completed = !spinning()
  for (let index = 0; index < 4; index++) await frame()
  const box = well()
  const finalChars = shown(box)
  const gap = box ? one('.well-gap', box) : null
  const gapText = text(gap) || null
  const beforeGap = (gap?.previousSibling?.textContent ?? '').slice(-40)
  const afterGap = (gap?.nextSibling?.textContent ?? '').slice(0, 40)
  // 第一行、最后一行：只看最前和最后一个文字节点，不拼整段
  const nodes: Text[] = []
  if (box) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  }
  const outputs = nodes.filter((node) => !node.parentElement?.closest('.well-gap'))
  const firstLine = (outputs[0]?.data ?? '').split('\n', 1)[0] ?? ''
  const tailText = outputs.at(-1)?.data ?? ''
  const lastLine = tailText.replace(/\n+$/, '').split('\n').at(-1) ?? ''
  const heapAfter = heap()
  // 收起来，回合停掉（打完之后还会照常回一段话）
  if (expand) head()?.click()
  if (running()) one<HTMLButtonElement>('.send.stop')?.click()
  await idle()

  const sorted = [...gaps].sort((a, b) => a - b)
  const pick = (q: number) => Math.round(sorted[Math.floor((sorted.length - 1) * q)] ?? 0)
  return {
    frames,
    maxShownChars,
    finalChars,
    frameMs: {
      median: pick(0.5),
      p95: pick(0.95),
      max: Math.round(sorted.at(-1) ?? 0),
      over100: gaps.filter((gap) => gap > 100).length,
    },
    maxOffBottom,
    completed,
    gapText,
    beforeGap,
    afterGap,
    firstLine,
    lastLine,
    heapBefore,
    heapAfter,
  }
}

/** 合不合格：只判和机器快慢无关的几样。帧间隔、内存只报数 */
export function judgeOutput(probe: OutputProbe, limit: number): string[] {
  const failed: string[] = []
  if (!probe.completed) failed.push('长输出：那条命令在时限之内没打完（界面跟不上？）')
  if (probe.frames < 10) failed.push(`长输出：狂打期间只取到 ${probe.frames} 帧`)
  if (!(probe.maxShownChars <= limit))
    failed.push(`长输出：展开着的输出框里最多有 ${probe.maxShownChars} 个字，上限 ${limit}`)
  if (!(probe.finalChars <= limit))
    failed.push(`长输出：打完之后输出框里有 ${probe.finalChars} 个字，上限 ${limit}`)
  if (!(probe.maxOffBottom <= 1))
    failed.push(`长输出：狂打期间输出框离开了底部（最远 ${probe.maxOffBottom} 像素）`)
  if (!probe.gapText?.includes('省略'))
    failed.push(`长输出：中间省掉的地方没有标出来（记号上是“${probe.gapText ?? ''}”）`)
  // 模拟核心打的每一行都不长：两刀都该落在行与行之间
  if (!probe.beforeGap.endsWith('\n') || !/^\[\d{7}\] /.test(probe.afterGap))
    failed.push(
      `长输出：中间省掉的地方没有切在行与行之间（${JSON.stringify(probe.beforeGap)} | ${JSON.stringify(probe.afterGap)}）`,
    )
  if (!probe.firstLine.startsWith('[0000001]'))
    failed.push(`长输出：输出框里的第一行不是最前那一行（“${probe.firstLine}”）`)
  // 每一行带着序号：最后一行要是几十万行之后的那一行，留的才是末尾
  const lastNumber = Number(probe.lastLine.match(/^\[(\d+)\]/)?.[1] ?? 0)
  if (!(lastNumber > 100_000))
    failed.push(`长输出：输出框里的最后一行不是末尾那一行（“${probe.lastLine}”）`)
  return failed
}
