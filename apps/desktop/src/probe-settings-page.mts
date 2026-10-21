// 设置页验收的第一段：这一页打得开、关得掉、五组都在；各个控件点了当场生效；皮肤的预览画的是那种皮肤。
// 下面的函数会被原样送进页面里执行，工具从 window 上取（probe-settings-kit.mts）。
import type { SettingsKit } from './probe-settings-kit.mjs'

export interface PageSeen {
  /** 侧栏底部的齿轮点开之后：标题栏上写的、左边有哪几组、默认在哪一组 */
  crumb: string
  sections: string[]
  first: string
  /** 入口那一行标成了“正开着” */
  entryCurrent: boolean
  /** 每一组点过去，右边的标题各是什么 */
  titles: string[]
  /** 这一页上没有终端面板和侧面板 */
  panelsHidden: boolean
  /** Esc 关掉、回到原来的地方；右上角的叉也关得掉 */
  escCloses: boolean
  closeButton: boolean
  /** 按“主修饰键加逗号”打开（页面自己认的那条路） */
  keyOpens: boolean
  /** 设置页左上角的“设备”“已归档对话”通到那两页 */
  toDevices: boolean
  toArchived: boolean
  /** 侧栏底部原来那三个临时按钮撤掉了 */
  oldButtons: number
}

export async function pageSeen(): Promise<PageSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, seen, one, all, text } = kit
  await until('侧栏', () => one('.sb-settings') && one('.ss-row'))
  await kit.openSettings()
  const crumb = text(one('.crumb'))
  const sections = all('.set-nav [data-section]').map((entry) => entry.dataset.section ?? '')
  const first = kit.settingsAt() ?? ''
  const entryCurrent = one('.sb-settings')?.getAttribute('aria-current') === 'page'
  const titles: string[] = []
  for (const section of sections) {
    await kit.openSettings(section)
    titles.push(text(one('.set-head h2')))
  }
  const panelsHidden = !one('.side') && !one('.term-panel')

  const press = (key: string, init: KeyboardEventInit = {}) =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  press('Escape')
  const escCloses = await seen(() => !one('.set-page') && one('.new-hero'), 3000)

  // 主修饰键：两个都认（macOS 上是 Cmd，别处是 Ctrl）
  press(',', { metaKey: true })
  const byMeta = await seen(() => one('.set-page'), 3000)
  one<HTMLButtonElement>('.set-head .ibtn')?.click()
  const closeButton = await seen(() => !one('.set-page'), 3000)
  press(',', { ctrlKey: true })
  const keyOpens = byMeta && (await seen(() => one('.set-page'), 3000))

  await kit.openSettings()
  one<HTMLButtonElement>('.set-go[data-page="devices"]')?.click()
  const toDevices = await seen(() => !one('.set-page') && one('.devp'), 3000)
  press('Escape')
  await seen(() => !one('.devp'), 3000)
  await kit.openSettings()
  one<HTMLButtonElement>('.set-go[data-page="archived"]')?.click()
  const toArchived = await seen(() => !one('.set-page') && one('.arch-page'), 3000)
  press('Escape')
  await seen(() => !one('.arch-page'), 3000)

  return {
    crumb,
    sections,
    first,
    entryCurrent,
    titles,
    panelsHidden,
    escCloses,
    closeButton,
    keyOpens,
    toDevices,
    toArchived,
    oldButtons: all('.look .mini').length,
  }
}

/** 应用菜单里点了一项之后：设置页开了没有、在哪一组。看完把它关掉 */
export async function menuSeen(): Promise<string> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  await kit.seen(() => kit.one('.set-page'), 3000)
  const at = kit.settingsAt() ?? '没开'
  kit.one<HTMLButtonElement>('.set-head .ibtn')?.click()
  await kit.seen(() => !kit.one('.set-page'), 3000)
  return at
}

export interface ControlsSeen {
  /** 每点一下之后根元素上的样子：“点了什么→皮肤/明暗/密度/语言” */
  steps: string[]
  /** 三档密度下侧栏里一行会话多高 */
  rowHeights: number[]
  /** 换成英文之后左边那几组的名字，换回中文之后的 */
  english: string[]
  chinese: string[]
  /** 语言那一排有哪几档（不该有“跟随系统”） */
  langChoices: string[]
  /** 缩放有哪几档；每一档点了之后页面的像素比是原来的几倍（缩放是外壳做的，页面看得到的就是这个数） */
  zoomChoices: string[]
  zoomRatios: number[]
  /** 都点完之后，本机存下来的那一份 */
  saved: string
}

export async function controlsSeen(): Promise<ControlsSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, one, all, text } = kit
  const root = document.documentElement
  const now = () =>
    [
      root.dataset.skin ?? '',
      root.dataset.theme ?? 'system',
      root.dataset.density ?? '',
      root.lang,
    ].join('/')
  const choice = (name: string, value: string | number) =>
    one<HTMLButtonElement>(`[data-choice="${name}"] [data-value="${value}"]`)
  const pressed = (name: string) =>
    one(`[data-choice="${name}"] [aria-pressed="true"]`)?.dataset.value ?? ''
  const steps: string[] = []

  await kit.openSettings('look')
  for (const skin of ['human', 'standard', 'retro']) {
    one<HTMLButtonElement>(`[data-skin-card="${skin}"]`)?.click()
    // 点了当场生效：同一个任务里就该写到根元素上了，不等下一帧
    steps.push(`皮肤 ${skin}→${now()}`)
    await until(`皮肤卡片“${skin}”标成选中`, () =>
      one(`[data-skin-card="${skin}"][aria-checked="true"]`),
    )
  }
  for (const theme of ['dark', 'light', 'system']) {
    choice('theme', theme)?.click()
    steps.push(`明暗 ${theme}→${now()}`)
    await until(`明暗“${theme}”标成选中`, () => pressed('theme') === theme)
  }
  const rowHeights: number[] = []
  for (const density of ['compact', 'roomy', 'standard']) {
    choice('density', density)?.click()
    steps.push(`密度 ${density}→${now()}`)
    await until(`密度“${density}”标成选中`, () => pressed('density') === density)
    rowHeights.push(one('.ss-row')?.offsetHeight ?? 0)
  }

  await kit.openSettings('lang')
  const langChoices = all('[data-choice="lang"] [data-value]').map(
    (entry) => entry.dataset.value ?? '',
  )
  const groups = () => all('.set-nav [data-section]').map(text)
  choice('lang', 'en')?.click()
  steps.push(`语言 en→${now()}`)
  await until('界面换成英文', () => one('.sb-settings')?.getAttribute('aria-label') === 'Settings')
  const english = groups()
  choice('lang', 'zh-CN')?.click()
  steps.push(`语言 zh-CN→${now()}`)
  await until('界面换回中文', () => one('.sb-settings')?.getAttribute('aria-label') === '设置')
  const chinese = groups()

  await kit.openSettings('look')
  const zoomChoices = all('[data-choice="zoom"] [data-value]').map(
    (entry) => entry.dataset.value ?? '',
  )
  const base = window.devicePixelRatio
  const zoomRatios: number[] = []
  for (const zoom of [...zoomChoices.filter((value) => value !== '1'), '1']) {
    choice('zoom', zoom)?.click()
    // 缩放要经外壳走一趟，不是同一个任务里的事：等页面的像素比变过去
    await kit.seen(() => Math.abs(window.devicePixelRatio / base - Number(zoom)) < 0.01, 5000)
    zoomRatios.push(Math.round((window.devicePixelRatio / base) * 1000) / 1000)
  }
  await until('缩放那一排标回 100%', () => pressed('zoom') === '1')
  return {
    steps,
    rowHeights,
    english,
    chinese,
    langChoices,
    zoomChoices,
    zoomRatios,
    saved: localStorage.getItem('litch.appearance') ?? '',
  }
}

export interface PreviewSeen {
  /**
   * 每一种“现在用的皮肤”下，三张预览卡各自画出来的样子，和那种皮肤真的用起来时的样子比：
   * “用着的皮肤｜预览的皮肤｜内容面的颜色 对不对｜字的颜色｜强调色｜字体｜圆角”，对的写“对”，不对的写出两边各是什么
   */
  rows: string[]
  /** 预览里的三张各不一样（不是三张都画成了现在这一种） */
  distinct: boolean
}

export async function previewSeen(): Promise<PreviewSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { one } = kit
  const SKINS = ['retro', 'human', 'standard']
  await kit.openSettings('look')
  const before = kit.look.get()
  /** 让浏览器在 scope 身上把这几个变量算出来 */
  const read = (scope: Element) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--ui)'
    scope.appendChild(probe)
    const style = getComputedStyle(probe)
    const color = (name: string) => {
      probe.style.color = `var(${name})`
      return style.color.replace(/\s/g, '')
    }
    probe.style.borderRadius = 'var(--r2)'
    const result = [
      color('--panel'),
      color('--ink'),
      color('--accent-solid'),
      style.fontFamily.split(',')[0]?.trim() ?? '',
      style.borderTopLeftRadius,
    ]
    probe.remove()
    return result
  }
  const rows: string[] = []
  let distinct = true
  for (const theme of ['light', 'dark']) {
    // 先记下每种皮肤真的用起来时的值
    const real: Record<string, string[]> = {}
    for (const skin of SKINS) {
      kit.look.set({ skin, theme })
      await kit.frame()
      real[skin] = read(document.body)
    }
    for (const using of SKINS) {
      kit.look.set({ skin: using, theme })
      await kit.frame()
      const drawn: string[] = []
      for (const skin of SKINS) {
        const preview = one(`[data-skin-preview="${skin}"]`)
        if (!preview) throw new Error(`没有“${skin}”的预览`)
        const got = read(preview)
        // 预览这一块自己的底色，就是那种皮肤内容面的颜色
        const painted = getComputedStyle(preview).backgroundColor.replace(/\s/g, '')
        const want = real[skin] ?? []
        const parts = got.map((value, index) =>
          value === want[index] ? '对' : `${value}≠${want[index]}`,
        )
        parts.push(painted === want[0] ? '对' : `底色 ${painted}≠${want[0]}`)
        rows.push(`${theme}/${using}｜${skin}｜${parts.join('｜')}`)
        drawn.push(got.join(','))
      }
      if (new Set(drawn).size !== SKINS.length) distinct = false
    }
  }
  kit.look.set({ skin: before.skin, theme: before.theme })
  await kit.frame()
  return { rows, distinct }
}
