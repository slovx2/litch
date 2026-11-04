// 普通文件验收：可访问的本机路径直接引用，无路径的文本与二进制都上传；超限文件明确拒绝。
// 远程那一步开着“操作本机”，两个文件都引用控制端路径；真实入口经隔离设备服务验证上传字节。
// 接在带着的文字那一组后面，模拟核心和真实入口都跑。
// 原生 codex 上“提到的文件把路径写进正文”这一条不在这里量：模拟核心里本机的 Codex 是没装上的样子，发不了消息；
// 它在核心的单元测试里（declared.test.mts），界面上的在“@ 提到文件”那一组里量（远程的 Codex 会话）。
// 选文件这一步由起自检的一方经调试接口做（把磁盘上真的文件放进输入区的文件选择框，和用户在对话框里选中是一回事，
// 文件对象带着磁盘上的位置），所以分成几步，一步一个 filesStep：先打开要用的会话，放好文件，再看结果。
// filesStep 会被原样送进页面里执行，不能引用函数外面的东西。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { runInPage } from './smoke.mjs'

export type FilesStage =
  /** 打开本机设备上收 mention 的会话（模拟核心里是 Claude Code 的，真实入口上是 Pi 的） */
  | 'open-local'
  | 'local'
  /** 打开远程设备上的会话。只在模拟核心上 */
  | 'open-remote'
  | 'remote'
  /** 新建对话页。只在模拟核心上 */
  | 'open-fresh'
  | 'fresh'

export interface FilesProbe {
  /**
   * 两个本机文件显示为文件卡；无路径的文本和二进制上传，超限文件拒绝。
   * 发送后保留文件卡、正文不展开内容；真实模型读回上传字节。
   */
  local: {
    chips: string[]
    titles: string[]
    button: string
    dropped: { files: string[]; said: string }
    sent: { mentions: string[]; body: string; cleared: boolean; heard: boolean | null }
    /** 一种一行：“皮肤/明暗｜横向溢出的像素｜文件片上的字的对比度” */
    layouts: string[]
  } | null
  /**
   * 远程设备开着“操作本机”：文本与二进制都按控制端路径引用，卡片说明路径归属。
   */
  remote: { text: string[]; files: number; titles: string[]; said: string; button: string } | null
  /** 新建对话页：选一个文本文件，显示一张文件卡 */
  fresh: { chips: number } | null
}

export async function filesStep(
  stage: FilesStage,
  real: boolean,
  dir: string,
): Promise<Partial<FilesProbe>> {
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
    throw new Error(`带文件（${stage}）：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  /** 回合的标识 */
  const turnOf = (entry: HTMLElement | undefined) => entry?.dataset.searchTurn ?? ''
  /**
   * 发出去的话落进了新回合：最后一个回合是按下发送之后才有的，里面的用户消息有这句话。给出那个回合。
   * 不数回合：刚切过来时回合列表延后取，旧回合又分批补画在前面（turn-window.ts），数目会自己涨；最后一个总是最新的
   */
  const landed = (words: string, lastBefore: string) => {
    const last = all('.turn').at(-1)
    return last &&
      turnOf(last) !== lastBefore &&
      all('.umsg-text', last).some((entry) => text(entry).includes(words))
      ? last
      : null
  }
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
  const fileChips = () => all('.dock .cmp-file-card .attachment-card-open')
  const textChips = () => all('.dock .cmp-chip[data-kind="text"]')
  const labels = (chips: HTMLElement[]) => chips.map((chip) => text(one('.ell', chip)))
  const hint = () => text(one('.dock .cmp-hint.err'))
  const button = () => one('.dock [data-act="attach"]')?.getAttribute('title') ?? ''
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 90_000)
  const clear = () => {
    for (const cross of all('.dock .cmp-chip-x')) cross.click()
    const field = area()
    if (field?.value) write(field, '')
  }
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row:not(.projection-group *)').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && area())
    await frame()
    await idle()
    clear()
    await until('文件选择框', () => one('.dock input[type="file"]'))
    await frame()
  }
  /** 发出去，等这一轮结束，给出那个回合 */
  const send = async (words: string) => {
    const lastBefore = turnOf(all('.turn').at(-1))
    const field = await until('输入框', area)
    field.focus()
    write(field, words)
    await frame()
    press(field, 'Enter')
    const sent = turnOf(await until('发出去的那一条', () => landed(words, lastBefore)))
    await frame()
    const cleared = all('.dock .cmp-atts > *').length === 0 && area()?.value === ''
    await idle()
    // 回合结束后正文仍可能匀速放字；等该回合定稿显示，不能用固定延时截取附件回执。
    const turn = await until('该回合正文显示完成', () => {
      const current = all('.turn').find((entry) => turnOf(entry) === sent)
      return current?.querySelector('.turn-foot') &&
        current.querySelector('.agent-message .md') &&
        !current.querySelector('.md.live')
        ? current
        : null
    })
    return { turn, cleared }
  }
  const NOTES = 'litch-notes.md'
  const BLOB = 'litch-blob.bin'

  if (stage === 'open-local') {
    await open(real ? '给首页加一个状态条' : '首页文案')
    return {}
  }
  if (stage === 'open-remote') {
    await open('核对构建机上的 codex 配置')
    return {}
  }
  if (stage === 'open-fresh') {
    one<HTMLButtonElement>('.sb-link.new')?.click()
    await until('新建对话页', () => one('.new-page .new-hero') && area())
    clear()
    await until('文件选择框', () => one('.dock input[type="file"]'))
    return {}
  }

  if (stage === 'local') {
    await until('提到的两个文件', () => fileChips().length === 2, 10_000).catch(() => null)
    const chips = labels(fileChips())
    const titles = fileChips().map((chip) => chip.getAttribute('title') ?? '')
    const shown = button()
    // 检查文件卡名字的对比度及附件行溢出。
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
    const readable = (element: HTMLElement | null) => {
      if (!element) return 0
      const under = backdrop(element)
      const ink = over(parse(getComputedStyle(element).color), under)
      const [high = 0, low = 0] = [luminance(ink), luminance(under)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const layouts: string[] = []
    if (!real) {
      // 换皮肤和明暗走界面给验收留的口子（window.__litchLook），不直接改根元素上的属性
      const appearance = (
        window as unknown as {
          __litchLook: {
            get(): { skin: string; theme: string }
            set(patch: { skin?: string; theme?: string }): void
          }
        }
      ).__litchLook
      const was = appearance.get()
      for (const skin of ['retro', 'human', 'standard']) {
        for (const theme of ['light', 'dark']) {
          appearance.set({ skin, theme })
          await sleep(200)
          const spill = Math.max(
            0,
            ...[one('.dock-in'), one('.dock .cmp-atts'), one('.dock .cmp-bar'), ...fileChips()].map(
              (box) => (box ? box.scrollWidth - box.clientWidth : 0),
            ),
          )
          layouts.push(
            `${skin}/${theme}｜${Math.ceil(spill)}｜${readable(one('.ell', fileChips()[0])).toFixed(1)}`,
          )
        }
      }
      appearance.set(was)
      await sleep(100)
    }
    // 二进制的那个拿掉，留下文本的
    all('.dock .cmp-chip-x').at(-1)?.click()
    await until('剩一个文件', () => fileChips().length === 1, 5000).catch(() => null)
    // 再拖进来两个拿不到路径的（不是从磁盘来的文件对象）
    const data = new DataTransfer()
    data.items.add(new File(['拖进来的一段\n记号 LITCH-DROP-6640'], 'dragged.txt'))
    data.items.add(new File([new Uint8Array([0x89, 0x50, 0, 1, 2, 0xff])], 'dragged.bin'))
    data.items.add(new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'too-large.bin'))
    one('.dock .cmp')?.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
    )
    await until('上传后两张文件卡', () => fileChips().length === 3, 30_000).catch(() => null)
    await until('带不上的说明', hint, 5000).catch(() => null)
    const dropped = {
      files: labels(fileChips()).filter((name) => name.startsWith('dragged.')),
      said: hint(),
    }
    const words = '看看这两个文件'
    const { turn, cleared } = await send(words)
    const bubble = one('.umsg', turn)
    const whole = text(turn)
    return {
      local: {
        chips,
        titles,
        button: shown,
        dropped,
        sent: {
          mentions: all('.atts .attachment-card-info > span', bubble ?? document).map(text),
          body: text(one('.umsg-text', bubble ?? document)),
          cleared,
          // 假模型从隔离设备的上传目录读回文本与二进制，证明真实字节已落盘且引用送到了模型。
          heard: real
            ? whole.split(`${dir}/${NOTES}`).length - 1 >= 1 &&
              whole.includes('LITCH-DROP-6640') &&
              whole.includes('8950000102ff')
            : null,
        },
        layouts,
      },
    }
  }

  if (stage === 'remote') {
    await until('这台电脑上的两张文件卡', () => fileChips().length === 2, 10_000).catch(() => null)
    const seen = {
      text: labels(textChips()),
      files: fileChips().length,
      titles: fileChips().map((chip) => chip.getAttribute('title') ?? ''),
      said: hint(),
      button: button(),
    }
    clear()
    await frame()
    return { remote: seen }
  }

  await until('选中的文件卡', () => fileChips().length > 0, 10_000).catch(() => null)
  const chips = fileChips().length
  clear()
  await frame()
  // 那两个名字只是给上面几步用的
  void [NOTES, BLOB]
  return { fresh: { chips } }
}

export function judgeFiles(probe: FilesProbe, real: boolean, dir: string): string[] {
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`带文件：${what}`)
  }
  const { local, remote, fresh } = probe
  if (!local) return ['带文件：本机设备上的那一步没有量到']
  check(
    local.chips.join() === 'litch-notes.md,litch-blob.bin',
    `本机设备上选两个文件，该是两张文件卡，实际是 ${local.chips.join() || '没有'}`,
  )
  check(
    local.titles.length === 2 && local.titles.every((title) => title.includes(dir)),
    `提到的文件那一片上没有完整的路径：${local.titles.join('；')}`,
  )
  check(local.button.length > 0, '加附件的按钮上没有写能带什么')
  check(
    local.dropped.files.join() === 'dragged.txt,dragged.bin',
    `无路径文本和二进制上传后应显示两张文件卡，实际是 ${local.dropped.files.join() || '没有'}`,
  )
  check(
    local.dropped.said.includes('too-large.bin'),
    `拖进来一个带不了的文件，没有说是哪个：“${local.dropped.said}”`,
  )
  check(local.sent.cleared, '发出去之后输入区里的片或者字还在')
  check(local.sent.body === '看看这两个文件', '文件内容或元数据不应展开到用户消息正文')
  check(
    local.sent.mentions.join() === 'litch-notes.md,dragged.txt,dragged.bin',
    `发出的文件卡不完整：${local.sent.mentions.join()}`,
  )
  if (real) {
    check(local.sent.heard === true, '真实入口：回话里没有那个文件的路径或者内容，它没到模型手里')
  } else {
    check(
      local.sent.mentions.includes('litch-notes.md'),
      `发出去的那条消息上没有提到的文件：${local.sent.mentions.join() || '没有'}`,
    )
    check(!local.sent.body.includes(dir), '收 mention 的 harness 上，路径又写进了正文')
    if (local.layouts.length !== 6) check(false, `该量 6 种样子，量了 ${local.layouts.length} 种`)
    for (const line of local.layouts) {
      const [which = '', spill = '', contrast = ''] = line.split('｜')
      if (spill !== '0') failed.push(`文件片的样子（${which}）：横向溢出 ${spill} 像素`)
      if (Number(contrast) < 4.5) {
        failed.push(`文件片的样子（${which}）：片上的字和底色分不开（${contrast}）`)
      }
    }
    check(remote !== null && fresh !== null, '有几步没有量到')
  }
  if (remote) {
    check(
      remote.text.length === 0 && remote.files === 2,
      `可访问控制端路径时，文本和二进制应都显示文件卡，实际是文字 ${remote.text.join() || '没有'}、文件 ${remote.files} 张`,
    )
    check(
      remote.titles.length === 2 &&
        remote.titles.every((title) => title.includes(dir) && title.includes('在这台电脑上')),
      `远程设备上二进制文件的片没有写明路径在这台电脑上：${remote.titles.join('；') || '没有'}`,
    )
    check(remote.said === '', `远程设备开着“操作本机”，不该有拒绝的说明：“${remote.said}”`)
    check(
      remote.button.includes('这台电脑'),
      `远程设备上加附件的按钮没有写其他文件以这台电脑上的路径提及：“${remote.button}”`,
    )
  }
  if (fresh) check(fresh.chips === 1, `新建对话页上选一个文件，该出一片，出了 ${fresh.chips} 片`)
  return failed
}

/** 把磁盘上的几个文件放进页面里的一个文件选择框：和用户在系统的对话框里选中它们是一回事 */
async function pickFiles(window: BrowserWindow, selector: string, files: string[]): Promise<void> {
  const wire = window.webContents.debugger
  const mine = !wire.isAttached()
  if (mine) wire.attach('1.3')
  try {
    const { root } = (await wire.sendCommand('DOM.getDocument', { depth: 0 })) as {
      root: { nodeId: number }
    }
    const { nodeId } = (await wire.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number }
    if (!nodeId) throw new Error(`带文件：页面里没有 ${selector}`)
    await wire.sendCommand('DOM.setFileInputFiles', { nodeId, files })
  } finally {
    if (mine) wire.detach()
  }
}

/** 跑完这一组：返回量到的和不合格的项 */
export async function runComposeFilesChecks(
  window: BrowserWindow,
  real: boolean,
): Promise<readonly [FilesProbe, string[]]> {
  // 两个真的文件，写在这次验收自己的数据目录里（跑完整个目录会被起自检的脚本删掉）
  const dir = join(app.getPath('userData'), 'attach-probe')
  mkdirSync(dir, { recursive: true })
  const notes = join(dir, 'litch-notes.md')
  const blob = join(dir, 'litch-blob.bin')
  writeFileSync(notes, '# 备忘\n记号 LITCH-FILE-2291\n')
  writeFileSync(blob, Buffer.from([0x89, 0x50, 0, 1, 2, 0xff, 0]))
  const input = '.dock input[type="file"]'
  const probe: FilesProbe = { local: null, remote: null, fresh: null }
  const step = async (stage: FilesStage) =>
    Object.assign(probe, await runInPage(window, filesStep, stage, real, dir))
  await step('open-local')
  await pickFiles(window, input, [notes, blob])
  await step('local')
  if (!real) {
    await step('open-remote')
    await pickFiles(window, input, [notes, blob])
    await step('remote')
    await step('open-fresh')
    await pickFiles(window, input, [notes])
    await step('fresh')
  }
  return [probe, judgeFiles(probe, real, dir)]
}
