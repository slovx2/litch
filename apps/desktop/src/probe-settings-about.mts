// 设置页验收的第四段：快捷键一览表、“关于”那一组，还有冷启动之后头一眼的样子。
// 快捷键这一段只把表上的东西读回来；和真的应用菜单对账在主进程那一头（probe-settings-judge.mts）。
import type { SettingsKit } from './probe-settings-kit.mjs'

export interface KeyRow {
  /** 清单里的标识、所在的分组、菜单里的那一项（没有就是空的） */
  id: string
  group: string
  menu: string
  /** 几种按法，写成能比的样子（修饰键排好序、全小写） */
  combos: string[]
  /** 行上给人看的字：说明，和键帽上的字 */
  what: string
  caps: string
}

export async function keysSeen(): Promise<KeyRow[]> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { all, one, text } = kit
  await kit.openSettings('keys')
  return all('.set-content [data-shortcut]').map((row) => ({
    id: row.dataset.shortcut ?? '',
    group: row.closest<HTMLElement>('[data-keys-group]')?.dataset.keysGroup ?? '',
    menu: row.dataset.menu ?? '',
    combos: (row.dataset.combos ?? '').split(' ').filter(Boolean),
    what: text(one('.key-what', row)),
    caps: all('.kbd', row).map(text).join(' '),
  }))
}

export interface AboutSeen {
  name: string
  /** 页上写的版本（data-version）和那一行字 */
  version: string
  versionLine: string
  runtime: string
  /** 项目主页：显示出来的字、点“复制”之后剪贴板里是什么、这段字能不能选 */
  home: string
  copied: string
  homeSelectable: boolean
  /** 许可：本项目的那一行上写的许可名、点开之后全文的头一行和长度 */
  projectKind: string
  projectHead: string
  projectLength: number
  noticesLength: number
  /** 第三方的包：有几个；点开头一个，名字和全文的长度；没有带的话那句说明 */
  packages: number
  firstPackage: string
  firstPackageLength: number
  unbundledNote: string
}

export async function aboutSeen(): Promise<AboutSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, one, all, text } = kit
  // 隐藏的窗口拿不到焦点，真的剪贴板写不进去：换成一个记下来的
  const clipboard: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void clipboard.push(value) },
  })
  await kit.openSettings('about')
  const version = await until('版本', () => one('.about-version')?.dataset.version)
  await until('许可这一块', () => one('.lic') || one('[data-packages="none"]'))
  const home = one('.about-home')
  one<HTMLButtonElement>('[data-act="copy-home"]')?.click()
  await kit.seen(() => clipboard.length === 1, 3000)

  /** 点开一行许可，等全文出来，读回来再收起 */
  const read = async (row: HTMLElement | null) => {
    if (!row) return ''
    one<HTMLButtonElement>('.fold', row)?.click()
    const body = await until('许可的全文', () => {
      const pre = one('.lic-text', row)
      const shown = text(pre)
      return shown && pre?.dataset.state !== 'loading' ? shown : null
    })
    one<HTMLButtonElement>('.fold', row)?.click()
    await kit.seen(() => !one('.lic-text', row), 2000)
    return body
  }
  const project = await read(one('[data-license="project"]'))
  const notices = await read(one('[data-license="notices"]'))
  const packages = all('[data-packages] [data-license]')
  const first = packages[0] ?? null
  const firstBody = await read(first)
  return {
    name: text(one('.about-name')),
    version,
    versionLine: text(one('.about-version')),
    runtime: text(one('.about-runtime')),
    home: text(home),
    copied: clipboard[0] ?? '',
    homeSelectable: home ? getComputedStyle(home).userSelect === 'text' : false,
    projectKind: text(one('[data-license="project"] .lic-kind')),
    projectHead: project.split('\n')[0] ?? '',
    projectLength: project.length,
    noticesLength: notices.length,
    packages: packages.length,
    firstPackage: first
      ? `${text(one('.lic-name', first))} ${text(one('.lic-version', first))}`
      : '',
    firstPackageLength: firstBody.length,
    unbundledNote: text(one('[data-packages="none"]')),
  }
}

export interface ColdSeen {
  /** 页面一加载完根元素上的样子、页面的底色、像素比是 100% 时的几倍 */
  root: string
  backdrop: string
  ratio: number
  /** 设置页里各排标着的是哪一档 */
  marked: string
  inner: string
}

/** 冷启动之后的头一眼。base：缩放是 100% 时页面的像素比（上一遍量的） */
export async function coldSeen(base: number): Promise<ColdSeen> {
  const root = document.documentElement
  const hex = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number)
    return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`
  }
  const seen = {
    root: [
      root.dataset.skin ?? '',
      root.dataset.theme ?? 'system',
      root.dataset.density ?? '',
      root.lang,
    ].join('/'),
    backdrop: hex(getComputedStyle(document.body).backgroundColor),
    ratio: Math.round((window.devicePixelRatio / base) * 1000) / 1000,
    inner: `${window.innerWidth}×${window.innerHeight}`,
  }
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  await kit.openSettings('look')
  const pressed = (name: string) =>
    kit.one(`[data-choice="${name}"] [aria-pressed="true"]`)?.dataset.value ?? ''
  const marked = [
    kit.one('[data-skin-card][aria-checked="true"]')?.dataset.skinCard ?? '',
    pressed('theme'),
    pressed('density'),
    pressed('zoom'),
  ].join('/')
  return { ...seen, marked }
}

/** 每种皮肤在浅色、深色下页面的底色（写成 #rrggbb）。拿去和外壳里那张底色表对 */
export async function backdropsSeen(): Promise<Record<string, { light: string; dark: string }>> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const before = kit.look.get()
  const hex = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number)
    return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`
  }
  const result: Record<string, { light: string; dark: string }> = {}
  for (const skin of ['retro', 'human', 'standard']) {
    const pair = { light: '', dark: '' }
    for (const theme of ['light', 'dark'] as const) {
      kit.look.set({ skin, theme })
      await kit.frame()
      pair[theme] = hex(getComputedStyle(document.body).backgroundColor)
    }
    result[skin] = pair
  }
  kit.look.set({ skin: before.skin, theme: before.theme })
  await kit.frame()
  return result
}
