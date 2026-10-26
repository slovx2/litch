// 皮肤与明暗。三种皮肤照桌面端（packages/ui/src/styles/skins/）：极客复古（默认）、文艺人文、标准。
// 配色在 palettes.ts；这里是每种皮肤的形状（圆角、字体、记号）。
// 字体不跟桌面全换：复古和标准正文用系统字体，等宽只给代码、路径、元信息；人文的标题、正文用衬线字。
// 组件里不写死颜色、圆角、记号，一律从 useTheme() 取。

import { createContext, useContext } from 'react'
import { Platform } from 'react-native'
import { PALETTES, type Palette, type Skin } from './palettes'

export type { Palette, Skin }

export const SKINS: readonly Skin[] = ['retro', 'human', 'standard']

export type StatusKind =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'error'
  | 'unread'
  | 'offline'
  | 'background'

/** 勾选的记号：开、关、部分 */
export interface CheckMarks {
  on: string
  off: string
  mixed: string
}

export interface Theme {
  skin: Skin
  dark: boolean
  c: Palette
  font: {
    mono: string
    /** 标题、正文的字体；不填是系统字体 */
    ui?: string
    /** 正文、标题、元信息、小字 */
    size: { body: number; title: number; meta: number; small: number }
  }
  /** 间距：4 的倍数 */
  space: (steps: number) => number
  /** 圆角：小（标签、小块）、中（按钮、输入框）、大（卡片、弹层） */
  radius: { s: number; m: number; l: number }
  /** 可点的东西至少这么高（触控目标） */
  hit: number
  /** 状态记号：用形状区分，不只靠颜色 */
  marks: Record<StatusKind, string>
  /** 单选、多选的记号 */
  radio: CheckMarks
  check: CheckMarks
  /** 待办一步的记号：没做、在做、做完 */
  todo: { pending: string; inProgress: string; completed: string }
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' })
const serif = Platform.select({ ios: 'Georgia', default: 'serif' })

type Shape = Omit<Theme, 'skin' | 'dark' | 'c' | 'font' | 'space' | 'hit'> & { ui?: string }

const SHAPES: Record<Skin, Shape> = {
  retro: {
    radius: { s: 0, m: 0, l: 0 },
    marks: {
      idle: '·',
      running: '▶',
      waiting: '◆',
      error: '✕',
      unread: '●',
      offline: '○',
      background: '&',
    },
    radio: { on: '[x]', off: '[ ]', mixed: '[-]' },
    check: { on: '[x]', off: '[ ]', mixed: '[-]' },
    todo: { pending: '[ ]', inProgress: '[~]', completed: '[x]' },
  },
  human: {
    ui: serif,
    radius: { s: 6, m: 10, l: 16 },
    marks: {
      idle: '·',
      running: '○',
      waiting: '◆',
      error: '✕',
      unread: '●',
      offline: '–',
      background: '○',
    },
    radio: { on: '●', off: '○', mixed: '◐' },
    check: { on: '☑', off: '☐', mixed: '▣' },
    todo: { pending: '○', inProgress: '◐', completed: '✓' },
  },
  standard: {
    radius: { s: 3, m: 6, l: 10 },
    marks: {
      idle: '·',
      running: '■',
      waiting: '◆',
      error: '✕',
      unread: '●',
      offline: '○',
      background: '■',
    },
    radio: { on: '●', off: '○', mixed: '◐' },
    check: { on: '☑', off: '☐', mixed: '▣' },
    todo: { pending: '○', inProgress: '◐', completed: '✓' },
  },
}

export function makeTheme(skin: Skin, isDark: boolean): Theme {
  const { ui, ...shape } = SHAPES[skin]
  return {
    ...shape,
    skin,
    dark: isDark,
    c: PALETTES[skin][isDark ? 'dark' : 'light'],
    font: { mono, ui, size: { body: 15, title: 17, meta: 13, small: 11 } },
    space: (steps) => steps * 4,
    hit: 44,
  }
}

export const ThemeContext = createContext<Theme>(makeTheme('retro', false))

export const useTheme = (): Theme => useContext(ThemeContext)
