// 侧栏验收：会话的工作目录不是工作区的根时，行上的小记号。
// 模拟核心里有三个这样的会话：本机 docs-site 里一个在子目录里开的，build-01 的 litch 里一个在子目录里开的，
// build-01 的 infra 里一个目录根本不在工作区里的。
// cwdSeen 会被原样送进页面里执行，不能引用函数外面的东西；judgeCwd 在主进程里跑。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

export interface CwdSeen {
  /** 带记号的行，从上到下：设备｜标题｜哪一种｜鼠标停在记号上的提示 */
  marked: string[]
  /** 记号给读屏的话和提示是同一句 */
  spoken: boolean
  /** 工作目录就是工作区的根的那一行、没有归属的那一行：有没有记号 */
  plain: boolean[]
  /** 记号在标题和徽标之间 */
  between: boolean
  /** 鼠标停到行上，信息卡里目录那一栏：目录｜多说的那一句。子目录的、不在工作区里的、平常的各一个 */
  cards: string[]
  /** 侧栏宽的时候、调到最窄之后，每个带记号的行：标题｜标题截断了没有｜图标（整个、没有、半个）｜图标多大 */
  wide: string[]
  narrow: string[]
  /** 最窄的时候标题右边到徽标左边隔多远：带记号而记号已经让掉的行、没有记号的行 */
  gaps: number[][]
  /** 看完之后侧栏的宽度（要调回原来的） */
  widthBack: number
  /** 六套皮肤明暗：哪里｜记号和底色的对比度｜带记号的行比别的行高多少 */
  skins: string[]
}

export async function cwdSeen(): Promise<CwdSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, text, until, frame } = kit
  const SUB = '导航栏按使用场景重排'
  const AWAY = '缓存目录配额'
  const AT_ROOT = '远程设备安装指引'
  const LOOSE = '查一下 launchd 的 KeepAlive 语义'
  const need = async (title: string) => until(`侧栏里的“${title}”`, () => kit.row(title), 10_000)
  await need(SUB)

  // ---- 一、哪些行有记号，写的是什么 ----
  const marks = () => all('.ss-row .cwd-mark')
  const marked = marks().map((mark) =>
    [
      mark.closest<HTMLElement>('.dev-group')?.dataset.device,
      text(one('.title', mark.closest('.ss-row') as HTMLElement)),
      mark.dataset.cwd,
      mark.title,
    ].join('｜'),
  )
  const spoken = marks().every(
    (mark) => mark.getAttribute('role') === 'img' && mark.getAttribute('aria-label') === mark.title,
  )
  const plain = [
    Boolean(one('.cwd-mark', await need(AT_ROOT))),
    Boolean(one('.cwd-mark', await need(LOOSE))),
  ]
  const first = marks()[0] as HTMLElement
  const between =
    first.previousElementSibling?.classList.contains('title') === true &&
    first.nextElementSibling?.classList.contains('chip') === true

  // ---- 二、信息卡里目录那一栏 ----
  const cards: string[] = []
  for (const title of [SUB, AWAY, AT_ROOT]) {
    const line = (await need(title)).parentElement as HTMLElement
    const shown = await kit.hover(line, `“${title}”`)
    const path = one('[data-session-info] .info-path', shown.card)
    cards.push(`${text(path)}｜${text(one('.info-cwd', path?.parentElement ?? shown.card))}`)
    await shown.close()
  }

  // ---- 三、标题优先：侧栏宽的时候记号都在；窄了、标题放不下的时候记号先让掉 ----
  const shape = (mark: HTMLElement) => {
    const icon = one('svg', mark) as unknown as SVGElement
    const [outer, inner] = [mark.getBoundingClientRect(), icon.getBoundingClientRect()]
    const whole =
      inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5
    const gone = inner.top >= outer.bottom - 0.5 || inner.left >= outer.right - 0.5
    return `${whole ? '整个' : gone ? '没有' : '半个'}｜${Math.round(inner.width)}x${Math.round(inner.height)}`
  }
  const each = () =>
    marks().map((mark) => {
      const title = one('.title', mark.closest('.ss-row') as HTMLElement) as HTMLElement
      return `${text(title)}｜${title.scrollWidth > title.clientWidth ? '截断' : '全'}｜${shape(mark)}`
    })
  const wide = each()
  const panel = one('.sb') as HTMLElement
  const handle = one('.sb-grip') as HTMLElement
  const widthBefore = panel.offsetWidth
  const turn = async (key: string, times: number) => {
    for (let count = 0; count < times; count++) kit.press(handle, key)
    await frame()
    await frame()
  }
  await turn('ArrowLeft', 12)
  const narrow = each()
  /** 标题右边到徽标左边隔多远 */
  const gap = (row: HTMLElement) =>
    Math.round(
      (one('.chip', row) as HTMLElement).getBoundingClientRect().left -
        (one('.title', row) as HTMLElement).getBoundingClientRect().right,
    )
  const yielded = marks()
    .filter((mark) => shape(mark).startsWith('没有'))
    .map((mark) => gap(mark.closest('.ss-row') as HTMLElement))
  const others = all('.ss-row')
    .filter((row) => !one('.cwd-mark', row))
    .map(gap)
  await turn('ArrowRight', Math.round((widthBefore - panel.offsetWidth) / 24))

  // ---- 四、六套皮肤：记号看得见，不把行撑高 ----
  const level = (await need(AT_ROOT)).offsetHeight
  const skins = await kit.eachSkin((where) => {
    const mark = marks()[0] as HTMLElement
    const row = mark.closest('.ss-row') as HTMLElement
    return [
      where,
      kit.contrast(getComputedStyle(mark).color, kit.backdrop(row)).toFixed(1),
      row.offsetHeight - level,
    ].join('｜')
  })

  return {
    marked,
    spoken,
    plain,
    between,
    cards,
    wide,
    narrow,
    gaps: [yielded, [...new Set(others)]],
    widthBack: panel.offsetWidth - widthBefore,
    skins,
  }
}

export function judgeCwd(seen: CwdSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    seen.marked.join('\n') ===
      [
        'local｜导航栏按使用场景重排｜sub｜工作目录是工作区里的子目录：~/work/docs-site/content/guide',
        'build｜差异面板的大文件降级｜sub｜工作目录是工作区里的子目录：/srv/work/litch/apps/desktop',
        'build｜缓存目录配额｜away｜工作目录不在这个工作区的目录里：/var/cache/ci',
      ].join('\n'),
    `工作目录不是工作区的根的会话，行上的记号不对：${seen.marked.join('；')}`,
  )
  must(seen.spoken, '工作目录的记号没有给读屏说清楚（该和提示是同一句）')
  must(
    seen.plain.join() === 'false,false',
    `工作目录就是工作区的根的、没有归属的会话，行上不该有记号：${seen.plain.join()}`,
  )
  must(seen.between, '工作目录的记号不在标题和徽标之间')
  must(
    seen.cards.join('\n') ===
      [
        '~/work/docs-site/content/guide｜工作区里的子目录',
        '/var/cache/ci｜不在这个工作区的目录里',
        '~/work/docs-site｜',
      ].join('\n'),
    `信息卡里目录那一栏不对：${seen.cards.join('；')}`,
  )
  const parse = (entry: string) => {
    const [title = '', cut = '', icon = '', size = ''] = entry.split('｜')
    return { title, cut: cut === '截断', icon, size }
  }
  const wide = seen.wide.map(parse)
  must(
    wide.length === 3 &&
      wide.every((row) => !row.cut && row.icon === '整个' && row.size === '12x12'),
    `侧栏宽的时候记号该都在、标题都不截断，记号 12 像素见方：${seen.wide.join('；')}`,
  )
  const narrow = seen.narrow.map(parse)
  // 不管多宽都得守住的：标题截断了，记号就不能还占着地方；记号露着就得是整个的
  for (const row of [...wide, ...narrow]) {
    must(row.icon !== '半个', `“${row.title}”的记号只露出了半个`)
    must(!(row.cut && row.icon !== '没有'), `“${row.title}”的标题被截断了，记号却还占着地方`)
  }
  must(
    narrow.some((row) => row.icon === '没有') && narrow.some((row) => row.icon === '整个'),
    `侧栏调到最窄：标题长的那几行记号该让掉，标题短的该还在：${seen.narrow.join('；')}`,
  )
  const [yielded = [], others = []] = seen.gaps
  must(
    yielded.length > 0 && others.length === 1 && yielded.every((gap) => gap === others[0]),
    `记号让掉之后，标题和徽标之间该和没有记号的行一样宽（${others.join()}）：${yielded.join()}`,
  )
  must(seen.widthBack === 0, `看完之后侧栏的宽度没有调回去：差 ${seen.widthBack}`)
  for (const entry of seen.skins) {
    const [where, contrast, taller] = entry.split('｜')
    must(Number(contrast) >= 3, `${where} 下工作目录的记号和底色分不开（对比度 ${contrast}）`)
    must(taller === '0', `${where} 下带记号的行比别的行高了 ${taller} 像素`)
  }
  must(seen.skins.length === 6, `皮肤没有量全：${seen.skins.length}`)
  return failed
}
