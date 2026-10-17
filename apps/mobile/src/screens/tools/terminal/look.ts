// 终端的配色：照桌面复古皮肤（packages/ui/src/styles/skins/retro.css 和 standard.css 的 --term-*），
// 底色是浮起的那一层，前景是正文墨色，十六色从主题的状态色、线色里取，主题里没有的几样按明暗各给一个。
import type { Theme } from '../../../ui/theme'

export interface TermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export function termTheme(theme: Theme): TermTheme {
  const { c, dark } = theme
  return {
    background: c.raised,
    foreground: c.ink,
    cursor: c.accent,
    cursorAccent: c.raised,
    selectionBackground: dark ? 'rgba(205,238,212,0.22)' : 'rgba(26,26,20,0.22)',
    black: dark ? '#3b3e4a' : '#2b2d36',
    red: c.err,
    green: c.ok,
    yellow: c.wait,
    blue: c.wire.blue,
    magenta: c.wire.violet,
    cyan: dark ? '#4fc3d1' : '#0f7f8c',
    white: c.ink2,
    brightBlack: c.ink3,
    brightRed: c.wire.red,
    brightGreen: c.wire.green,
    brightYellow: c.wire.yellow,
    brightBlue: c.accent,
    brightMagenta: dark ? '#d3a8ff' : '#a25fe0',
    brightCyan: dark ? '#7ad9e4' : '#1795a4',
    brightWhite: c.ink,
  }
}

/** 终端的字号：手机上一屏要放得下 80 列左右，字比正文小 */
export const TERM_FONT_SIZE = 11
