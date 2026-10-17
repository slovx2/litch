// 颜色、字号、间距。取桌面端默认皮肤“极客复古”的配色（packages/ui/src/styles/skins/retro.css）：
// 浅色是米色机箱和打印纸，深色是绿色单色显示器；方角、实线。字体不跟桌面全用等宽：
// 手机上正文用系统字体更好读，等宽只给代码、路径、元信息（2026-10-17 定的默认，可推翻）。
// 组件里不写死颜色，一律从 useTheme() 取。

import type { WireColor } from '@litch/core'
import { createContext, useContext } from 'react'
import { Platform } from 'react-native'

export interface Palette {
  /** 页面底色（窗口） */
  win: string
  /** 面板、列表的底色 */
  panel: string
  /** 浮起来的一层：卡片、气泡、输入框、对话区 */
  raised: string
  /** 凹下去的一层：代码块、输入槽 */
  sunken: string
  ink: string
  ink2: string
  ink3: string
  line1: string
  line2: string
  line3: string
  press: string
  sel: string
  accent: string
  /** 实心按钮的底和上面的字 */
  accentSolid: string
  onAccent: string
  ok: string
  wait: string
  err: string
  /** 反白（选中态） */
  invBg: string
  invFg: string
  wire: Record<WireColor, string>
}

const light: Palette = {
  win: '#d9d3be',
  panel: '#e8e3d1',
  raised: '#f4f0e2',
  sunken: '#ddd7c3',
  ink: '#1a1a14',
  ink2: '#4b4a3d',
  ink3: '#726f59',
  line1: 'rgba(26,26,20,0.18)',
  line2: 'rgba(26,26,20,0.5)',
  line3: '#1a1a14',
  press: 'rgba(26,26,20,0.16)',
  sel: 'rgba(26,26,20,0.14)',
  accent: '#0b6b3d',
  accentSolid: '#1a1a14',
  onAccent: '#f4f0e2',
  ok: '#0b6b3d',
  wait: '#9a5b00',
  err: '#b3261e',
  invBg: '#1a1a14',
  invFg: '#f4f0e2',
  wire: {
    blue: '#2f6fe0',
    orange: '#d2651a',
    green: '#2b9348',
    brown: '#8a5a3c',
    slate: '#5f6b7a',
    red: '#c9423a',
    yellow: '#a88400',
    violet: '#8d4bd1',
  },
}

const dark: Palette = {
  win: '#09100b',
  panel: '#0c150f',
  raised: '#121e16',
  sunken: '#060b08',
  ink: '#cdeed4',
  ink2: '#8dba98',
  ink3: '#5f8a6c',
  line1: 'rgba(205,238,212,0.14)',
  line2: 'rgba(205,238,212,0.32)',
  line3: 'rgba(205,238,212,0.7)',
  press: 'rgba(205,238,212,0.16)',
  sel: 'rgba(205,238,212,0.14)',
  accent: '#4dff88',
  accentSolid: '#35d873',
  onAccent: '#04130a',
  ok: '#4dff88',
  wait: '#ffb83d',
  err: '#ff6a5c',
  invBg: '#cdeed4',
  invFg: '#07100a',
  wire: {
    blue: '#6ea3ff',
    orange: '#ff9a4d',
    green: '#57c878',
    brown: '#c08d6b',
    slate: '#9aa6b5',
    red: '#ff7469',
    yellow: '#e6c544',
    violet: '#c08cff',
  },
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' })

export interface Theme {
  dark: boolean
  c: Palette
  font: {
    mono: string
    /** 正文、标题、元信息、小字 */
    size: { body: number; title: number; meta: number; small: number }
  }
  /** 间距：4 的倍数 */
  space: (steps: number) => number
  /** 圆角。复古皮肤全是方角，留着这一项是为了以后加别的皮肤 */
  radius: number
  /** 可点的东西至少这么高（触控目标） */
  hit: number
}

export function makeTheme(isDark: boolean): Theme {
  return {
    dark: isDark,
    c: isDark ? dark : light,
    font: { mono, size: { body: 15, title: 17, meta: 13, small: 11 } },
    space: (steps) => steps * 4,
    radius: 0,
    hit: 44,
  }
}

export const ThemeContext = createContext<Theme>(makeTheme(false))

export const useTheme = (): Theme => useContext(ThemeContext)
