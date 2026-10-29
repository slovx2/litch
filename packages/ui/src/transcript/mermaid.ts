// Mermaid 画图。画图库很大（几 MB），第一次遇到 mermaid 代码块时才装载，不进首屏的包。
// 严格模式（securityLevel: 'strict'）：图里的点击脚本不执行，标签里的 HTML 当文字，输出的 SVG 由画图库自己净化过。
// 颜色、字体从当前皮肤取，所以皮肤或明暗一换就要重画：结果按“外观 + 原文”记着，换回来不用再画。
import { useSyncExternalStore } from 'react'
import { onAppearanceChange } from '../app/appearance.ts'

type Library = typeof import('mermaid').default

let library: Promise<Library> | null = null
const load = (): Promise<Library> => {
  library ??= import('mermaid').then((module) => module.default)
  return library
}

/** 一次只画一张：画图库的配置是全局的，换配置和画图要连在一起 */
let queue: Promise<unknown> = Promise.resolve()
let serial = 0

/** 画好的图，按“外观 + 原文”记着。对话区滚动时块会卸下又装上，不用每次重画 */
const drawn = new Map<string, Promise<string>>()
const KEEP = 60

/** 画一张图，给回 SVG 的原文。语法错时抛出画图库的错误 */
export function drawMermaid(source: string, look: string): Promise<string> {
  const key = `${look}\n${source}`
  const known = drawn.get(key)
  if (known) return known
  const job = queue.then(async () => {
    const mermaid = await load()
    mermaid.initialize(config(look))
    serial += 1
    const { svg } = await mermaid.render(`litch-mmd-${serial}`, source)
    return svg
  })
  queue = job.catch(() => {})
  drawn.set(key, job)
  // 画不出来的不记：多半是还没写完的图，下次原文就变了
  job.catch(() => drawn.delete(key))
  if (drawn.size > KEEP) drawn.delete(drawn.keys().next().value as string)
  return job
}

/** 画图库报错的第一行，给块头上用 */
export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? text
  )
}

function config(look: string) {
  const dark = look.endsWith(':dark')
  const color = palette()
  const font = getComputedStyle(document.documentElement).getPropertyValue('--ui').trim()
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    // 画不出来的时候不往页面里插那张“炸弹”图，由块头说
    suppressErrorRendering: true,
    // 标签用 SVG 的文字，不用 foreignObject 里的 HTML：页面上的段落样式不会漏进去
    htmlLabels: false,
    theme: 'base' as const,
    darkMode: dark,
    fontFamily: font,
    themeVariables: {
      darkMode: dark,
      fontFamily: font,
      fontSize: `${13 * Number(look.split(':')[1])}px`,
      // 画图库默认给节点加一道固定灰色的投影，换了皮肤也不变，在深色里像一圈光晕
      dropShadow: 'none',
      background: color.sunken,
      primaryColor: color.raised,
      primaryTextColor: color.ink,
      primaryBorderColor: color.line3,
      secondaryColor: color.panel,
      secondaryTextColor: color.ink,
      secondaryBorderColor: color.line2,
      tertiaryColor: color.sunken,
      tertiaryTextColor: color.ink,
      tertiaryBorderColor: color.line2,
      mainBkg: color.raised,
      nodeBorder: color.line3,
      nodeTextColor: color.ink,
      textColor: color.ink,
      titleColor: color.ink,
      lineColor: color.ink3,
      clusterBkg: color.panel,
      clusterBorder: color.line2,
      edgeLabelBackground: color.sunken,
      noteBkgColor: color.overlay,
      noteTextColor: color.ink,
      noteBorderColor: color.line2,
      actorBkg: color.raised,
      actorBorder: color.line3,
      actorTextColor: color.ink,
      actorLineColor: color.ink3,
      signalColor: color.ink2,
      signalTextColor: color.ink,
      labelBoxBkgColor: color.raised,
      labelBoxBorderColor: color.line3,
      labelTextColor: color.ink,
      loopTextColor: color.ink,
      activationBkgColor: color.panel,
      activationBorderColor: color.line2,
      sequenceNumberColor: color.onAccent,
      errorBkgColor: color.sunken,
      errorTextColor: color.err,
    },
  }
}

/**
 * 当前皮肤的几种颜色，都换成不透明的十六进制（画图库的主题只认这种写法）：
 * 皮肤里的线色是带透明度的墨色，按代码块的底色（--sunken）叠出来。
 */
function palette() {
  const probe = document.createElement('span')
  probe.hidden = true
  document.body.append(probe)
  const read = (name: string): number[] => {
    probe.style.color = `var(--${name})`
    return channels(getComputedStyle(probe).color)
  }
  const base = read('sunken')
  const hex = (name: string) => toHex(read(name), base)
  const color = {
    sunken: toHex(base, base),
    panel: hex('panel'),
    raised: hex('raised'),
    overlay: hex('overlay'),
    ink: hex('ink'),
    ink2: hex('ink-2'),
    ink3: hex('ink-3'),
    line2: hex('line-2'),
    line3: hex('line-3'),
    onAccent: hex('on-accent'),
    err: hex('err'),
  }
  probe.remove()
  return color
}

/** 算出来的颜色（rgb(…) 或 rgba(…)）拆成 r、g、b、a */
function channels(value: string): number[] {
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? []
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
}

function toHex([r = 0, g = 0, b = 0, a = 1]: number[], [br = 0, bg = 0, bb = 0]: number[]): string {
  const mix = (top: number, under: number) =>
    Math.round(top * a + under * (1 - a))
      .toString(16)
      .padStart(2, '0')
  return `#${mix(r, br)}${mix(g, bg)}${mix(b, bb)}`
}

const darkQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

/** 皮肤、对话字号、明暗组成缓存键；字号变了也要按新的文字尺寸重排图。 */
function currentLook(): string {
  const root = document.documentElement
  const theme = root.dataset.theme ?? (darkQuery()?.matches ? 'dark' : 'light')
  const scale = getComputedStyle(root).getPropertyValue('--fs-chat').trim() || '1'
  return `${root.dataset.skin ?? ''}:${scale}:${theme}`
}

function subscribe(listener: () => void): () => void {
  const query = darkQuery()
  query?.addEventListener('change', listener)
  const stop = onAppearanceChange(listener)
  return () => {
    query?.removeEventListener('change', listener)
    stop()
  }
}

export const useLook = (): string => useSyncExternalStore(subscribe, currentLook)
