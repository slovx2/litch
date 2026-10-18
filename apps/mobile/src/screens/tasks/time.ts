// 表单里手机上敲字的几样小事：时刻的几种写法整理成 HH:MM、数字栏的字和数来回换。
// 表单的样子、校验在桌面界面那一份（packages/ui/src/tasks/form.ts）；它要的时刻是严格的 HH:MM，
// 手机上敲“9”“930”的多，失去焦点时先整理一下。单测在 test/tasks.test.mjs。

const pad = (value: number) => String(value).padStart(2, '0')

/** 用户敲的时刻整理成 HH:MM：认 9、9:5、930、0930、09:30 这几种写法；认不出是 null */
export function tidyTime(text: string): string | null {
  const trimmed = text.trim()
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed) ?? /^(\d{1,2}):(\d)$/.exec(trimmed)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour > 23 || minute > 59) return null
  return `${pad(hour)}:${pad(minute)}`
}

/** 数字栏敲的字换成数；空着或不是整数是 NaN（checkForm 认作没填对） */
export const numberOf = (text: string): number =>
  /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN

/** 数换回栏里的字；NaN 是空着 */
export const textOf = (value: number): string => (Number.isNaN(value) ? '' : String(value))
