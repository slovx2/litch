// 外观和语言：皮肤、明暗、密度、界面缩放、界面语言。记在本机，改了立刻生效。改的入口在设置页（settings/）。
// 首帧由 public/prepaint.js 先按同样的规则写到根元素上（那是个赶在样式之前跑的普通脚本，逻辑要和这里保持一致）。
import { useMemo, useSyncExternalStore } from 'react'
import { type Lang, type Translator, translator } from '../i18n/index.ts'

export const SKINS = ['retro', 'human', 'standard'] as const
export const THEMES = ['system', 'light', 'dark'] as const
/** 密度：列表一行多高、行与行之间留多少。三档的取值在 styles/theme.css */
export const DENSITIES = ['compact', 'standard', 'roomy'] as const
/**
 * 界面缩放的几档。整套字号和间距等比放大缩小，由桌面外壳按这个倍数缩放整个页面（和浏览器的缩放是同一回事），
 * 所以样式里的像素数都不用动。在普通浏览器里没有外壳，这一项不起作用，用浏览器自己的缩放
 */
export const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const
export const LANGS: readonly Lang[] = ['zh-CN', 'en']

export type Skin = (typeof SKINS)[number]
export type Theme = (typeof THEMES)[number]
export type Density = (typeof DENSITIES)[number]
export type Zoom = (typeof ZOOMS)[number]

export interface Appearance {
  skin: Skin
  theme: Theme
  density: Density
  zoom: Zoom
  lang: Lang
}

const STORAGE_KEY = 'litch.appearance'
const DEFAULTS = { skin: 'retro', theme: 'system', density: 'standard', zoom: 1 } as const

/** 系统的语言里我们有的那一种；没有对应的就是英文 */
const systemLang = (): Lang => (navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')

const pick = <T extends string | number>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

function readSaved(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    // 读不到就用默认外观
    return {}
  }
}

/** 地址里带的临时指定（?lang=en&skin=human&theme=dark）：截图和自检用，优先于记下来的，但不会被记下来 */
function readOverrides(): Partial<Appearance> {
  const params = new URLSearchParams(location.search)
  const result: Partial<Appearance> = {}
  if (params.has('skin')) result.skin = pick(SKINS, params.get('skin'), DEFAULTS.skin)
  if (params.has('theme')) result.theme = pick(THEMES, params.get('theme'), DEFAULTS.theme)
  if (params.has('lang')) result.lang = pick(LANGS, params.get('lang'), systemLang())
  return result
}

const overrides = readOverrides()
const saved = readSaved()

/**
 * 语言没有“跟随系统”这一档：第一次启动时按系统语言替用户选好并记下来，之后就是用户自己的选择，
 * 系统语言再变也不跟着变。地址里临时指定了语言的这一次不记。
 */
function firstLang(): Lang {
  const lang = systemLang()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, lang }))
  } catch {
    // 记不下来的话下次启动再选一遍
  }
  return lang
}

let current: Appearance = {
  skin: overrides.skin ?? pick(SKINS, saved.skin, DEFAULTS.skin),
  theme: overrides.theme ?? pick(THEMES, saved.theme, DEFAULTS.theme),
  density: pick(DENSITIES, saved.density, DEFAULTS.density),
  zoom: pick(ZOOMS, saved.zoom, DEFAULTS.zoom),
  lang: overrides.lang ?? (LANGS.includes(saved.lang as Lang) ? (saved.lang as Lang) : firstLang()),
}
const listeners = new Set<() => void>()

function apply(): void {
  const root = document.documentElement
  root.dataset.skin = current.skin
  if (current.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = current.theme
  root.dataset.density = current.density
  root.lang = current.lang
  // 在桌面外壳里：应用菜单是外壳画的，把语言告诉它；
  // 缩放是外壳做的，窗口在页面画出来之前的底色也是它的，把皮肤、明暗、缩放告诉它（它记着，下次冷启动用）
  const shell = window.litchShell
  shell?.setLanguage(current.lang)
  shell?.setLook({ skin: current.skin, theme: current.theme, zoom: current.zoom })
}

export function setAppearance(patch: Partial<Appearance>): void {
  current = { ...current, ...patch }
  apply()
  try {
    // 只把这次改的那几项记下来：别的项如果是地址里临时指定的，不该跟着进去
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readSaved(), ...patch }))
  } catch {
    // 记不下来不影响这一次的显示
  }
  for (const listener of listeners) listener()
}

/** 缩放往大或往小走一档，到头了就不动；reset 回到 100% */
export function stepZoom(step: 'in' | 'out' | 'reset'): void {
  const at = ZOOMS.indexOf(current.zoom)
  const next =
    step === 'reset'
      ? DEFAULTS.zoom
      : ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + (step === 'in' ? 1 : -1)))]
  if (next !== undefined && next !== current.zoom) setAppearance({ zoom: next })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const currentLang = (): Lang => current.lang

/**
 * 外观变了的时候叫一声（皮肤、明暗、密度、缩放、语言，哪一样变了都叫）。给不在组件里的代码用；返回的函数用来不再听。
 * 叫的时候根元素上的属性已经换了，但版面还没重排：这时候记着的位置都还是换之前的
 */
export const onAppearanceChange = (listener: () => void): (() => void) => subscribe(listener)

export const useAppearance = (): Appearance => useSyncExternalStore(subscribe, () => current)

/** 取当前语言的文案函数。语言一换，用它的组件会重画 */
export function useT(): Translator {
  const { lang } = useAppearance()
  return useMemo(() => translator(lang), [lang])
}

/**
 * 给验收脚本（和开发时在控制台里）换外观用的口子：不依赖设置页摆在哪、控件长什么样。
 * 走的就是设置页用的那个函数，所以会记下来、会告诉外壳，和人在设置页里点是一回事
 */
export interface LookHandle {
  get(): Appearance
  set(patch: Partial<Appearance>): void
}

declare global {
  interface Window {
    __litchLook?: LookHandle
  }
}

window.__litchLook = { get: () => current, set: setAppearance }

// 应用菜单“显示”里的放大、缩小、实际大小：外壳只转告是哪一项，走哪一档由这里定
window.litchShell?.onMenu?.((action) => {
  if (action === 'zoom.in') stepZoom('in')
  else if (action === 'zoom.out') stepZoom('out')
  else if (action === 'zoom.reset') stepZoom('reset')
})

apply()
