// 设置页验收的第三段：六套组合（三种皮肤乘深浅）下，把以前没量过的几屏各过一遍——对话区、侧栏、审批卡片、
// 已归档对话、定时任务（列表、详情、表单）、设置页的各组——有没有横向溢出、有没有读不清的字（量法在 probe-settings-kit.mts 的 audit）。
// 设备列表、新建对话页、提问向导、设备管理、终端、文件在各自的验收里量过，这里不重复。
// 再加一段：缩放到最大和最小时，对话区和文件树（只画看得见的行的那种列表）对不对。
import type { Audit, SettingsKit } from './probe-settings-kit.mjs'

export interface ScreenRow {
  /** 哪一屏、哪一套：“对话区/retro/light”；设置页的几组还带语言 */
  where: string
  audit: Audit
}

export interface ScreensSeen {
  rows: ScreenRow[]
  /** 量的时候审批卡片在不在、已归档的列表有几行（证明量的确实是那一屏） */
  cardShown: boolean
  archivedRows: number
  /** 定时任务列表有几行、详情里的运行记录有几条 */
  taskRows: number
  taskRuns: number
}

export async function screensSeen(titles: { talk: string; waiting: string }): Promise<ScreensSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, one, all } = kit
  const SKINS = ['retro', 'human', 'standard']
  const THEMES = ['light', 'dark']
  const before = kit.look.get()
  const rows: ScreenRow[] = []
  /** 在六套组合下各量一遍 scopes 这几块，记在 name 名下 */
  const sweep = async (name: string, scopes: string[]) => {
    for (const skin of SKINS) {
      for (const theme of THEMES) {
        kit.look.set({ skin, theme })
        await kit.settled()
        for (const scope of scopes) {
          const part = scopes.length > 1 ? `${name}${scope}` : name
          rows.push({ where: `${part}/${skin}/${theme}`, audit: kit.audit(scope) })
        }
      }
    }
  }

  // 对话区：一个带工具调用、代码块、文件改动的会话，等它流完再量（内容不再变）。标题栏和侧栏跟着一起量
  await kit.openSession(titles.talk)
  await until('回答出完', () => !one('.md.live') && one('.tr .md'), 90_000)
  await sweep('对话区', ['.main', '.tb', '.sb'])

  // 审批卡片：一打开就等着审批的那个会话
  await kit.openSession(titles.waiting)
  const cardShown = Boolean(await until('审批卡片', () => one('.req')))
  await sweep('审批卡片', ['.main'])

  // 已归档对话
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进已归档对话的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="archived"]'),
    )
  ).click()
  await until('已归档对话那一页', () => one('.arch-page') && all('.arch-item').length > 0)
  const archivedRows = all('.arch-item').length
  await sweep('已归档', ['.main'])
  one<HTMLButtonElement>('.arch-head .ibtn')?.click()

  // 定时任务：列表；一个有几次运行（有失败、有成功）的任务的详情，运行记录取到了再量；新建表单
  one<HTMLButtonElement>('.sb-btn.tasks')?.click()
  await until('定时任务列表', () => one('[data-tasks="list"]') && all('.tk-row').length > 0)
  const taskRows = all('.tk-row').length
  await sweep('定时任务', ['.main'])
  one<HTMLButtonElement>('.tk-row[data-task="task-deps"] .tk-row-btn')?.click()
  await until('定时任务的运行记录', () => all('.tk-run').length > 0)
  const taskRuns = all('.tk-run').length
  await sweep('定时任务·详情', ['.main'])
  one<HTMLButtonElement>('[data-tasks="detail"] [data-act="back"]')?.click()
  await until('回到定时任务列表', () => one('[data-act="new-task"]'))
  one<HTMLButtonElement>('[data-act="new-task"]')?.click()
  await until('新建定时任务的表单', () => one('.tk-form'))
  await sweep('定时任务·表单', ['.main'])
  one<HTMLButtonElement>('[data-tasks="form"] .arch-head .ibtn:last-child')?.click()
  await until('关掉定时任务那一页', () => !one('[data-tasks]'))

  // 设置页的各组（照左边列出来的，Computer Use 只在 macOS 上有）：中文量一遍，英文（字更长）量一遍。
  // “关于”里点开一份许可再量；内置浏览器、Computer Use 等清单和权限取到了再量
  await kit.openSettings()
  const sections = all('.set-nav [data-section]').map((entry) => entry.dataset.section ?? '')
  for (const lang of ['zh-CN', 'en']) {
    kit.look.set({ lang })
    for (const section of sections) {
      await kit.openSettings(section)
      if (section === 'about') {
        const fold = await until('“关于”里的许可', () =>
          one<HTMLButtonElement>('.lic .fold, .set-para'),
        )
        if (fold.matches('.fold') && fold.getAttribute('aria-expanded') !== 'true') fold.click()
      }
      if (section === 'browser' || section === 'computer') {
        await until(`“${section}”那一组取到`, () =>
          all('.set-content [data-sites], .set-content [data-perms]').every(
            (block) =>
              (block.dataset.sites ?? block.dataset.perms) !== 'loading' &&
              block.dataset.checking !== 'true',
          ),
        )
      }
      await sweep(`设置·${section}·${lang}`, ['.main'])
    }
  }
  kit.look.set({ skin: before.skin, theme: before.theme, lang: before.lang })
  one<HTMLButtonElement>('.set-head .ibtn')?.click()
  await kit.settled()
  return { rows, cardShown, archivedRows, taskRows, taskRuns }
}

export interface ZoomLists {
  /** 页面里面多大（样式的像素）、像素比 */
  inner: string
  ratio: number
  /** 对话区：横向溢出的地方；贴着底部时内容底边到视口底边差多少像素 */
  talkOverflow: string[]
  talkGap: number
  /** 文件树：一行多高、画出来的行把看得见的地方盖满了没有（滚到中间再看一次）、垫高的那一层是不是行数乘行高 */
  treeRowHeight: number
  treeCovers: boolean
  treeCoversMid: boolean
  treePadExact: boolean
  /** 侧面板和文件树有没有横向溢出 */
  sideOverflow: string[]
}

/** 现在这个缩放下，对话区和文件树对不对。侧面板要先开着（文件标签） */
export async function zoomLists(talk: string): Promise<ZoomLists> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, one, all, frame } = kit
  await kit.openSession(talk)
  await until('回答出完', () => !one('.md.live') && one('.tr .md'), 90_000)
  one<HTMLButtonElement>('.to-bottom')?.click()
  await kit.settled()
  const scroller = one('.tr-scroll') as HTMLElement
  const content = one('.tr') as HTMLElement
  const talkGap =
    Math.round(
      (content.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom) * 100,
    ) / 100
  const talkOverflow = kit.audit('.main').overflow

  const tree = await until('文件树', () => one('.ft-scroll'))
  await until('文件树里的行', () => all('.ft-row', tree).length > 3)
  /** 画出来的行有没有把看得见的地方盖满：头一行不低于上边，最后一行不高于下边（行不够多、到了尽头也算盖满） */
  const covers = () => {
    const view = tree.getBoundingClientRect()
    const drawn = all('.ft-row, .ft-note', tree).map((row) => row.getBoundingClientRect())
    const first = Math.min(...drawn.map((box) => box.top))
    const last = Math.max(...drawn.map((box) => box.bottom))
    const atEnd = tree.scrollTop + tree.clientHeight >= tree.scrollHeight - 1
    return first <= view.top + 0.5 && (last >= view.bottom - 0.5 || atEnd)
  }
  tree.scrollTop = 0
  await frame()
  await frame()
  const treeCovers = covers()
  const treeRowHeight = one('.ft-row', tree)?.getBoundingClientRect().height ?? 0
  const pad = one('.ft-pad', tree)
  // 垫高的那一层：整棵树摊平之后的行数乘行高。行数从它自己的高度反推，必须是整数行
  const padHeight = pad?.getBoundingClientRect().height ?? 0
  const treePadExact =
    padHeight > 0 &&
    Math.abs(padHeight / treeRowHeight - Math.round(padHeight / treeRowHeight)) < 0.01
  tree.scrollTop = Math.max(0, (tree.scrollHeight - tree.clientHeight) / 2)
  await frame()
  await frame()
  const treeCoversMid = covers()
  tree.scrollTop = 0
  return {
    inner: `${window.innerWidth}×${window.innerHeight}`,
    ratio: window.devicePixelRatio,
    talkOverflow,
    talkGap,
    treeRowHeight,
    treeCovers,
    treeCoversMid,
    treePadExact,
    sideOverflow: kit.audit('.side').overflow,
  }
}
