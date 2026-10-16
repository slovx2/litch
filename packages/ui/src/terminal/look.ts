// 终端控件的配色和字体：从皮肤的变量里读（styles/skins/ 里的 --term-*），换皮肤、换明暗时重读。
// 终端控件要的是算好的颜色值，不认变量：这里借一个看不见的元素让浏览器把变量算出来。
import type { ITheme } from '@xterm/xterm'

export interface Look {
  theme: ITheme
  fontFamily: string
  fontSize: number
  lineHeight: number
}

/** 终端控件配色里的每一项各用哪个变量 */
const COLORS: { [K in keyof ITheme]?: string } = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  cursorAccent: '--term-bg',
  selectionBackground: '--term-sel',
  selectionInactiveBackground: '--term-sel',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white',
  // 滚动条：平时很淡，鼠标上去、拖着的时候深一点
  scrollbarSliderBackground: '--line-2',
  scrollbarSliderHoverBackground: '--line-3',
  scrollbarSliderActiveBackground: '--line-3',
}

const hex = (value: number): string =>
  Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, '0')

/**
 * 浏览器算出来的颜色换成终端控件认的写法。算出来的是 rgb(…)、rgba(…)，用了混色的是 color(srgb …)。
 * 不透明的给 #rrggbb；带透明度的（选区）给 rgba(…)
 */
export function cssColor(computed: string): string {
  const numbers = computed
    .match(/-?\d*\.?\d+(?:e-?\d+)?%?/g)
    ?.map((part) => Number.parseFloat(part))
  if (!numbers || numbers.length < 3) return computed
  const unit = computed.startsWith('color(') ? 255 : 1
  const [red = 0, green = 0, blue = 0, alpha = 1] = numbers
  const solid = `#${hex(red * unit)}${hex(green * unit)}${hex(blue * unit)}`
  if (alpha >= 1) return solid
  return `rgba(${Math.round(red * unit)}, ${Math.round(green * unit)}, ${Math.round(blue * unit)}, ${alpha})`
}

/** 读现在这套皮肤和明暗下的配色与字体。scope：变量在它身上取（终端面板里的任何一个元素都行） */
export function readLook(scope: HTMLElement): Look {
  const probe = document.createElement('span')
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;font-family:var(--mono)'
  scope.appendChild(probe)
  const style = getComputedStyle(probe)
  const theme: Record<string, string> = {}
  for (const [name, variable] of Object.entries(COLORS)) {
    probe.style.color = `var(${variable})`
    theme[name] = cssColor(style.color)
  }
  const fontFamily = style.fontFamily
  const root = getComputedStyle(scope)
  const fontSize = Number.parseFloat(root.getPropertyValue('--term-font-size')) || 13
  const lineHeight = Number.parseFloat(root.getPropertyValue('--term-line-height')) || 1.25
  probe.remove()
  return { theme: theme as ITheme, fontFamily, fontSize, lineHeight }
}

/** 字体文件装载好了再量字宽：没装好就量，终端的列数会按后备字体算，字一到就对不齐 */
export async function fontsReady(look: Look): Promise<void> {
  const first = look.fontFamily.split(',')[0]?.trim()
  if (!first || !document.fonts?.load) return
  try {
    await Promise.all([
      document.fonts.load(`${look.fontSize}px ${first}`),
      document.fonts.load(`600 ${look.fontSize}px ${first}`),
    ])
  } catch {
    // 装不上就用后备字体
  }
}

/** 字节数给人看：1.2 KB、3.4 MB */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
