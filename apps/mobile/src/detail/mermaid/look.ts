// 画图的配色和字体：照桌面端（packages/ui/src/transcript/mermaid.ts）的取法，从当前皮肤、明暗的配色取。
// 画图库的主题只认不透明的十六进制，配色里带透明度的线色按代码块的底色（sunken）叠出来。
// 皮肤或明暗一换配色就是另一份对象，配置跟着换，画过的图按“外观 + 原文”另记一份。
import type { Theme } from '../../ui/theme'

export interface MermaidLook {
  /** 外观的标识：皮肤加明暗，进缓存的键 */
  key: string
  /** 交给 mermaid.initialize 的配置 */
  config: Record<string, unknown>
}

const cache = new WeakMap<Theme['c'], MermaidLook>()

export function mermaidLook({
  c,
  skin,
  dark,
  font,
}: Pick<Theme, 'c' | 'skin' | 'dark' | 'font'>): MermaidLook {
  const known = cache.get(c)
  if (known) return known
  const base = channels(c.sunken)
  const hex = (color: string) => toHex(channels(color), base)
  const color = {
    sunken: toHex(base, base),
    panel: hex(c.panel),
    raised: hex(c.raised),
    ink: hex(c.ink),
    ink2: hex(c.ink2),
    ink3: hex(c.ink3),
    line2: hex(c.line2),
    line3: hex(c.line3),
    onAccent: hex(c.onAccent),
    err: hex(c.err),
  }
  const fontFamily = webFont(font.ui)
  const look: MermaidLook = {
    key: `${skin}:${dark ? 'dark' : 'light'}`,
    config: {
      startOnLoad: false,
      securityLevel: 'strict',
      // 画不出来的时候不往页面里插那张“炸弹”图，由卡片说
      suppressErrorRendering: true,
      // 标签用 SVG 的文字，不用 foreignObject：画到画布上导出缩略图时不会被当成跨域内容
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: 'base',
      darkMode: dark,
      fontFamily,
      themeVariables: {
        darkMode: dark,
        fontFamily,
        fontSize: '13px',
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
        noteBkgColor: color.panel,
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
    },
  }
  cache.set(c, look)
  return look
}

/** RN 的字体名换成网页里的写法：没写是系统字体，serif、Georgia 这类照写并带上通用的衬线字 */
function webFont(ui: string | undefined): string {
  if (!ui) return 'sans-serif'
  return ui === 'serif' ? 'serif' : `${ui}, serif`
}

/** #rgb、#rrggbb、rgb(…)、rgba(…) 拆成 r、g、b、a */
export function channels(value: string): number[] {
  const short = /^#([0-9a-f]{3})$/i.exec(value)?.[1]
  const long = /^#([0-9a-f]{6})$/i.exec(value)?.[1] ?? short?.replace(/./g, (d) => d + d)
  if (long) return [0, 2, 4].map((at) => Number.parseInt(long.slice(at, at + 2), 16)).concat(1)
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? []
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
}

/** 叠到底色上，写成不透明的 #rrggbb */
export function toHex(
  [r = 0, g = 0, b = 0, a = 1]: number[],
  [br = 0, bg = 0, bb = 0]: number[],
): string {
  const mix = (top: number, under: number) =>
    Math.round(top * a + under * (1 - a))
      .toString(16)
      .padStart(2, '0')
  return `#${mix(r, br)}${mix(g, bg)}${mix(b, bb)}`
}
