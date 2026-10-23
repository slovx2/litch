// 三种皮肤的配色，照桌面端的皮肤变量（packages/ui/src/styles/skins/）取值。
// 手机上描边比桌面略重一档：小屏上很淡的线分不清边界。
import type { WireColor } from '@litch/core'

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
  /** 淡的选中底：高亮一行、跳到的位置 */
  sel: string
  accent: string
  /** 实心按钮的底和上面的字 */
  accentSolid: string
  onAccent: string
  ok: string
  wait: string
  err: string
  /** 未读的记号 */
  seal: string
  /** 选中态（单选、多选、当前项）：复古皮肤是反白，另外两种是强调色的淡底 */
  selBg: string
  selFg: string
  /** 反白：小标签、图片上的按钮 */
  invBg: string
  invFg: string
  wire: Record<WireColor, string>
}

export type Skin = 'retro' | 'human' | 'standard'

/** 浅色是米色机箱和打印纸，深色是绿色单色显示器 */
const retroLight: Palette = {
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
  seal: '#0b6b3d',
  selBg: '#1a1a14',
  selFg: '#f4f0e2',
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

const retroDark: Palette = {
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
  seal: '#4dff88',
  selBg: '#cdeed4',
  selFg: '#07100a',
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

/** 冷灰底，靛蓝强调色 */
const standardLight: Palette = {
  win: '#e8eaef',
  panel: '#f6f7f9',
  raised: '#ffffff',
  sunken: '#eceef2',
  ink: '#191a21',
  ink2: '#50535f',
  ink3: '#7d808c',
  line1: 'rgba(25,26,33,0.08)',
  line2: 'rgba(25,26,33,0.18)',
  line3: 'rgba(25,26,33,0.3)',
  press: 'rgba(25,26,33,0.1)',
  sel: 'rgba(25,26,33,0.08)',
  accent: '#4a4dd8',
  accentSolid: '#4a4dd8',
  onAccent: '#ffffff',
  ok: '#1f8a4c',
  wait: '#a86a00',
  err: '#cc3b31',
  seal: '#4a4dd8',
  selBg: 'rgba(74,77,216,0.12)',
  selFg: '#191a21',
  invBg: '#191a21',
  invFg: '#ffffff',
  wire: retroLight.wire,
}

const standardDark: Palette = {
  win: '#111217',
  panel: '#16171d',
  raised: '#1d1f26',
  sunken: '#0c0d11',
  ink: '#e7e8ef',
  ink2: '#a6a9b7',
  ink3: '#747786',
  line1: 'rgba(231,232,239,0.08)',
  line2: 'rgba(231,232,239,0.18)',
  line3: 'rgba(231,232,239,0.3)',
  press: 'rgba(231,232,239,0.1)',
  sel: 'rgba(231,232,239,0.08)',
  accent: '#9da0ff',
  accentSolid: '#6266ea',
  onAccent: '#ffffff',
  ok: '#4cc38a',
  wait: '#f0b23e',
  err: '#ff6f65',
  seal: '#9da0ff',
  selBg: 'rgba(157,160,255,0.16)',
  selFg: '#e7e8ef',
  invBg: '#e7e8ef',
  invFg: '#111217',
  wire: retroDark.wire,
}

/** 线装书：浅色是素纸和松烟墨，强调色取书衣的磁青；深色是磁青纸上写泥金 */
const humanLight: Palette = {
  win: '#ebe7db',
  panel: '#f7f4ec',
  raised: '#fffdf8',
  sunken: '#efebe0',
  ink: '#24282c',
  ink2: '#585c5e',
  ink3: '#7f8079',
  line1: 'rgba(36,40,44,0.07)',
  line2: 'rgba(36,40,44,0.15)',
  line3: 'rgba(36,40,44,0.26)',
  press: 'rgba(36,40,44,0.09)',
  sel: 'rgba(42,77,115,0.1)',
  accent: '#2a4d73',
  accentSolid: '#2a4d73',
  onAccent: '#fbf8f0',
  ok: '#3f7553',
  wait: '#a2641a',
  err: '#b3402f',
  seal: '#b3402f',
  selBg: 'rgba(42,77,115,0.11)',
  selFg: '#24282c',
  invBg: '#24282c',
  invFg: '#fffdf8',
  wire: {
    blue: '#3b6ea8',
    orange: '#b9652b',
    green: '#4b8a63',
    brown: '#86604a',
    slate: '#5d6873',
    red: '#b5483b',
    yellow: '#a3831a',
    violet: '#7a5a9e',
  },
}

const humanDark: Palette = {
  win: '#111923',
  panel: '#16202c',
  raised: '#1d2937',
  sunken: '#0e151e',
  ink: '#ece7d9',
  ink2: '#b2b3ab',
  ink3: '#7e868e',
  line1: 'rgba(236,231,217,0.07)',
  line2: 'rgba(236,231,217,0.15)',
  line3: 'rgba(236,231,217,0.26)',
  press: 'rgba(236,231,217,0.09)',
  sel: 'rgba(220,189,114,0.13)',
  accent: '#dcbd72',
  accentSolid: '#cdaa58',
  onAccent: '#1c1608',
  // 深色里强调色是淡金，“等人”改用橘色避开它
  ok: '#86c79b',
  wait: '#f0915a',
  err: '#f2727b',
  seal: '#e8705f',
  selBg: 'rgba(220,189,114,0.15)',
  selFg: '#ece7d9',
  invBg: '#ece7d9',
  invFg: '#111923',
  wire: {
    blue: '#86b0e0',
    orange: '#e3a06c',
    green: '#86c49c',
    brown: '#c39b82',
    slate: '#9ba6b2',
    red: '#e88a7d',
    yellow: '#d9bd5c',
    violet: '#b79ad8',
  },
}

export const PALETTES: Record<Skin, { light: Palette; dark: Palette }> = {
  retro: { light: retroLight, dark: retroDark },
  human: { light: humanLight, dark: humanDark },
  standard: { light: standardLight, dark: standardDark },
}
