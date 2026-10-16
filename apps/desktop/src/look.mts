// 外观里要外壳来办的那几样：窗口在页面画出来之前的底色、整个页面的缩放、窗口最小能缩到多小。
// 选择本身是界面的事，记在界面本地（packages/ui/src/app/appearance.ts）；界面每次启动和每次改的时候报过来，
// 外壳照办并记一份在用户数据目录的 preferences.json 里，下次冷启动、页面还没起来的时候先按这一份来。
// 两份对不上的时候以界面那份为准：它一起来就会再报一遍。
import { readPreferences, writePreference } from './preferences.mjs'

const SKINS = ['retro', 'human', 'standard'] as const
const THEMES = ['system', 'light', 'dark'] as const

export interface ShellLook {
  skin: (typeof SKINS)[number]
  theme: (typeof THEMES)[number]
  /** 页面的缩放倍数。有哪几档由界面定，这里只认一个合理的范围 */
  zoom: number
}

export const DEFAULT_LOOK: ShellLook = { skin: 'retro', theme: 'system', zoom: 1 }

/**
 * 每种皮肤内容面的颜色（样式里的 --panel，页面的底色就是它），浅色和深色各一个。
 * 和 packages/ui/src/styles/skins/ 里的值要一样：设置页的验收（probe-settings-about.mts 的 backdropsSeen）会拿页面上算出来的底色来对
 */
export const BACKDROPS: Record<ShellLook['skin'], { light: string; dark: string }> = {
  retro: { light: '#e8e3d1', dark: '#0c150f' },
  human: { light: '#f7f4ec', dark: '#16202c' },
  standard: { light: '#f6f7f9', dark: '#16171d' },
}

/** 窗口最小的大小，按 100% 缩放算。缩放之后页面里能用的地方（按样式的像素算）不该比它小 */
export const MIN_SIZE = { width: 900, height: 560 } as const

/** 界面报来的东西是不是一份像样的外观。不像样的是 null，不照办也不记 */
export function parseLook(value: unknown): ShellLook | null {
  if (typeof value !== 'object' || value === null) return null
  const { skin, theme, zoom } = value as Record<string, unknown>
  if (!SKINS.includes(skin as ShellLook['skin'])) return null
  if (!THEMES.includes(theme as ShellLook['theme'])) return null
  if (typeof zoom !== 'number' || !(zoom >= 0.5 && zoom <= 2)) return null
  return { skin: skin as ShellLook['skin'], theme: theme as ShellLook['theme'], zoom }
}

/** 上一次记下来的外观。没记过、读不懂就是默认的 */
export function readLook(dataDir: string): ShellLook {
  return parseLook(readPreferences(dataDir).look) ?? DEFAULT_LOOK
}

export function writeLook(dataDir: string, look: ShellLook): void {
  writePreference(dataDir, 'look', look)
}

/** 这份外观下窗口的底色。systemDark：系统现在是不是深色（明暗跟随系统时用） */
export function backdropOf(look: ShellLook, systemDark: boolean): string {
  const dark = look.theme === 'system' ? systemDark : look.theme === 'dark'
  return BACKDROPS[look.skin][dark ? 'dark' : 'light']
}

/**
 * 这个缩放倍数下窗口最小能缩到多小：让页面里能用的地方始终不小于 MIN_SIZE，
 * 这样各页“最窄的窗口里也排得下”的结论在任何缩放下都成立。屏幕放不下那么大的就以屏幕能用的地方为限
 */
export function minSizeOf(
  zoom: number,
  workArea: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: Math.min(Math.ceil(MIN_SIZE.width * zoom), workArea.width),
    height: Math.min(Math.ceil(MIN_SIZE.height * zoom), workArea.height),
  }
}
