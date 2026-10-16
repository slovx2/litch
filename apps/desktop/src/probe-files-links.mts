// 文件面板的验收（模拟核心）：右键菜单、加入对话、复制路径；对话里提到的文件路径点得开、定位到行。
// 编排在 probe-files-run.mts。
import type { FilesKit } from './probe-files-kit.mjs'

export interface MenuSeen {
  /** 文件上点右键：菜单里有哪几项、各写的什么 */
  items: string[]
  labels: string[]
  /** 点了右键的那一行成了选中的；菜单出来时焦点在第一项上 */
  selectedOnContext: boolean
  focusFirst: boolean
  /** 上下键在几项之间走 */
  arrowMoved: boolean
  /** 按 Esc 收起，焦点回到树上 */
  escClosed: boolean
  escRefocused: boolean
  /** 点到外面也收起 */
  outsideClosed: boolean
  /** 键盘上的菜单键（Shift+F10）也叫得出来 */
  keyboardMenu: boolean
  /** 复制相对路径、复制完整路径：各复制了什么，提示写的什么 */
  copiedRelative: string
  copiedFull: string
  copyToast: string
  /** 加入对话：输入框上面多了哪几片（片上的字，逗号连着），焦点在不在输入框里，输入框里的字有没有被动过 */
  mentioned: string
  mentionFocus: boolean
  mentionTyped: string
  /** 那一片指的路径（提示里写的）：相对会话的工作目录 */
  mentionPath: string
  /** 再把一个目录加进去：接在后面，目录带斜杠 */
  dirMentioned: string
  /** 查看器标题栏上的“加入对话” */
  headMentioned: string
  /** 同一个文件再加一遍，还是那几片 */
  againMentioned: string
}

export async function mockMenu(): Promise<MenuSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame } = kit
  // 验收的窗口不显示，系统的剪贴板写不进去：换成一个记下来的
  const clipboard: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void clipboard.push(value) },
  })
  const menu = () => one('.pick-pop[role="menu"]')
  const pick = async (relative: string, action: string) => {
    kit.context(await kit.rowShown(relative))
    const shown = await until('菜单', menu)
    one<HTMLButtonElement>(`[data-action="${action}"]`, shown)?.click()
    await until('菜单收了', () => !menu())
  }
  const area = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
  kit.write(area, '')
  await frame()

  kit.tree()?.focus()
  kit.context(await kit.rowShown('Makefile'))
  const first = await until('菜单', menu)
  const items = all('button', first).map((button) => button.dataset.action ?? '')
  const labels = all('button', first).map(text)
  const selectedOnContext = kit.row('Makefile')?.getAttribute('aria-selected') === 'true'
  const focusFirst = await kit.seen(() => document.activeElement === one('button', first), 2000)
  kit.press(document.activeElement ?? first, 'ArrowDown')
  await frame()
  const arrowMoved = document.activeElement === all('button', first)[1]
  kit.press(document.activeElement ?? first, 'Escape')
  const escClosed = await kit.seen(() => !menu(), 2000)
  const escRefocused = document.activeElement === kit.tree()

  kit.context(await kit.rowShown('Makefile'))
  await until('菜单', menu)
  one('.fv')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  const outsideClosed = await kit.seen(() => !menu(), 2000)

  // 菜单键：在选中的那一行上出
  kit.tree()?.focus()
  kit.press(kit.tree() as HTMLElement, 'F10', { shiftKey: true })
  const keyboardMenu = await kit.seen(menu, 2000)
  if (menu()) kit.press(menu() as HTMLElement, 'Escape')
  await kit.seen(() => !menu(), 2000)

  await pick('Makefile', 'copyRelative')
  await until('复制到了', () => clipboard.length === 1)
  const copyToast = await until('复制了的提示', () => kit.toast('files-copied'))
  await pick('Makefile', 'copyFull')
  await until('又复制了一次', () => clipboard.length === 2)

  // 加入对话：变成输入框上面的一片（和打 @ 选中的是同一种），输入框里已经写的字不动
  const chips = () => all('.dock .cmp-chip[data-kind="file"]')
  const chipNames = () =>
    chips()
      .map((chip) => text(one('.ell', chip)))
      .join(',')
  kit.write(area, '先写的字')
  await frame()
  await pick('Makefile', 'mention')
  await until('多了一片', () => chips().length === 1)
  const mentioned = chipNames()
  const mentionPath = chips()[0]?.title ?? ''
  const mentionTyped = area.value
  const mentionFocus = await kit.seen(() => document.activeElement === area, 2000)
  await pick('docs', 'mention')
  await until('目录也加进去了', () => chips().length === 2)
  const dirMentioned = chipNames()

  await kit.open('package.json')
  one<HTMLButtonElement>('.fv-head [data-tool="mention"]')?.click()
  await until('查看器里加的也到了', () => chips().length === 3)
  const headMentioned = chipNames()
  one<HTMLButtonElement>('.fv-head [data-tool="mention"]')?.click()
  await frame()
  await frame()
  const againMentioned = chipNames()
  // 收拾：片一个个拿掉，字清掉
  for (let left = chips().length; left > 0; left -= 1) {
    one<HTMLButtonElement>('.cmp-chip-x', chips()[0])?.click()
    await until('拿掉了一片', () => chips().length === left - 1)
  }
  kit.write(area, '')
  await frame()

  return {
    items,
    labels,
    selectedOnContext,
    focusFirst,
    arrowMoved,
    escClosed,
    escRefocused,
    outsideClosed,
    keyboardMenu,
    copiedRelative: clipboard[0] ?? '',
    copiedFull: clipboard[1] ?? '',
    copyToast,
    mentioned,
    mentionFocus,
    mentionTyped,
    mentionPath,
    dirMentioned,
    headMentioned,
    againMentioned,
  }
}

export interface JumpSeen {
  /** 点的是哪个链接 */
  label: string
  /** 查看器里开的是谁（相对路径）、是不是预览 */
  file: string
  preview: boolean
  /** 要定位的行；那一行画出来了、在看得见的地方、标了出来 */
  line: number | null
  inView: boolean
  marked: boolean
  /** 树里它是选中的 */
  selected: boolean
  /** 点下去到定位好，多久（毫秒） */
  ms: number
}

export interface LinksSeen {
  /** 回答里认成了文件的：每项写成“显示的字→相对路径[:行]” */
  links: string[]
  /** 回答里没认成文件的行内代码和外链 */
  plain: string[]
  /** 面板收着的时候点链接：面板自己开了，看的是文件标签 */
  panelOpened: boolean
  jumps: JumpSeen[]
  /** 滚走之后同一个链接再点一次：又回到那一行 */
  again: boolean
  /** 工具改过的文件（文件改动的详情里那一行路径）也点得开 */
  toolLinks: string[]
  toolOpened: string
}

export async function mockLinks(session: string, toolSession: string): Promise<LinksSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame, sleep } = kit
  const relative = (path: string) => path.slice(kit.root().length + 1)
  await kit.openSession(session)
  const turnsBefore = all('.turn').length
  await kit.say('看文件')
  const turn = await until(
    '带路径的回答',
    () => {
      const last = all('.turn').at(-1)
      return all('.turn').length > turnsBefore &&
        !one('.running-line') &&
        all('a.file-link', last).length >= 6
        ? last
        : null
    },
    40_000,
  )
  const anchors = all('a.file-link', turn)
  const links = anchors.map(
    (anchor) =>
      `${text(anchor)}→${relative(anchor.dataset.file ?? '')}${anchor.dataset.line ? `:${anchor.dataset.line}` : ''}`,
  )
  const plain = [
    ...all('.md code', turn)
      .filter((code) => !one('a.file-link', code))
      .map(text),
    ...all('.md a:not(.file-link)', turn).map(text),
  ]

  // 收起面板再点：它得自己开
  if (kit.sideOpen()) {
    // 开合有一小段防重的时间：上一次开合刚过的话等一等
    await sleep(200)
    kit.toggle()
    await until('面板收起', () => !kit.sideOpen())
    await sleep(200)
  }
  const jumps: JumpSeen[] = []
  const jump = async (label: string): Promise<JumpSeen> => {
    const anchor = anchors.find((entry) => text(entry) === label)
    if (!anchor) throw new Error(`回答里没有这个链接：${label}（有：${links.join('，')}）`)
    const file = relative(anchor.dataset.file ?? '')
    const line = anchor.dataset.line ? Number(anchor.dataset.line) : null
    const started = performance.now()
    kit.click(anchor)
    await kit.viewed(file, 30_000)
    const inView = line === null ? true : await kit.seen(() => kit.lineInView(line), 10_000)
    const ms = performance.now() - started
    await frame()
    const marked =
      line === null ? !one('.cl.hl') : one('.cl.hl')?.getAttribute('data-line') === String(line)
    const selected = await kit.seen(
      () => kit.row(file)?.getAttribute('aria-selected') === 'true',
      10_000,
    )
    const seen: JumpSeen = {
      label,
      file,
      preview: kit.tabs().find((tab) => tab.active)?.preview === true,
      line,
      inView,
      marked,
      selected,
      ms,
    }
    jumps.push(seen)
    return seen
  }
  await jump('cmd/codex-harness-adapter/serve.go:131')
  const panelOpened =
    kit.sideOpen() && one('.side-tab[aria-selected="true"]')?.dataset.tab === 'files'
  await jump('fixtures/long.ts:4200')
  await jump(text(anchors.find((anchor) => anchor.dataset.line === '12')))
  await jump('README.md')

  // 同一个链接再点一次：先滚走
  await jump('fixtures/long.ts:4200')
  const view = kit.code()
  if (view) view.scrollTop = 0
  await until('滚走了', () => !kit.lineInView(4200))
  kit.click(anchors.find((entry) => text(entry) === 'fixtures/long.ts:4200') as HTMLElement)
  const again = await kit.seen(() => kit.lineInView(4200), 10_000)

  // ---------- 工具改过的文件 ----------
  await kit.openSession(toolSession)
  const toolAnchors = async () => {
    // 文件改动的详情收在活动条目里：一层一层点开，直到看见路径
    for (let round = 0; round < 4; round++) {
      const found = all('.file-head a.file-link')
      if (found.length > 0) return found
      for (const head of all('.turn [aria-expanded="false"]')) head.click()
      await frame()
      await sleep(60)
    }
    return all('.file-head a.file-link')
  }
  const tools = await toolAnchors()
  const toolLinks = tools.map((anchor) => text(anchor))
  let toolOpened = ''
  const target = tools.find((anchor) => text(anchor).endsWith('serve_test.go'))
  if (target) {
    kit.click(target)
    const file = relative(target.dataset.file ?? '')
    await kit.viewed(file, 30_000)
    toolOpened = file
  }

  return { links, plain, panelOpened, jumps, again, toolLinks, toolOpened }
}
