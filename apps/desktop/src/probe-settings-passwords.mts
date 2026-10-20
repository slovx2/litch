// 设置页“内置浏览器”一组里“已保存的密码”的验收（设置页验收头一遍的一段，接在 toolsSeen 之后、
// 那里点过“清除浏览数据”，所以顺带量了清除浏览数据不碰密码）。用户数据目录里的 browser/passwords.json 是 scripts/check-settings.mjs
// 起外壳之前写进去的三条，加密的那一栏是假的（列、搜、删都不解密，用不到钥匙串）。
// 和别的验收一样，passwordsSeen 会被原样送进页面里执行，只能用参数和 window 上的东西。
import type { SettingsKit } from './probe-settings-kit.mjs'

/** check-settings.mjs 写进去的三条：两条同一个站点 */
export const SEEDED_PASSWORDS = [
  { origin: 'https://bank.example', username: 'ann@example.com' },
  { origin: 'https://bank.example', username: 'bob@example.com' },
  { origin: 'https://mail.example', username: 'carol' },
]
/** 加密那一栏写的假值：界面上、外壳给界面的列表里都不该出现 */
export const SEEDED_SEALED = 'U0VBTEVELU5PVC1BLVJFQUwtUEFTU1dPUkQ='

export interface PasswordsSeen {
  /** 那一块的样子：loading、failed、empty、list */
  phase: string
  rows: number
  /** 外壳给界面的列表里每一条的键 */
  keys: string[]
  /** 页面上那一块的字里有没有加密那一栏的值 */
  leaked: boolean
  /** 搜“bank”、搜“bank bob”之后剩几行 */
  searchBank: number
  searchBankBob: number
  /** 有三行时那一块的横向溢出、读不清的字（kit.audit） */
  overflow: string[]
  unreadable: string[]
}

export interface PasswordsRemoved {
  /** 删一条之后剩几行 */
  afterRemove: number
  /** 全删：先出确认框，确认后出提示、变成空的样子 */
  confirmShown: boolean
  removedToast: boolean
  emptyAfter: boolean
}

export async function passwordsSeen(sealed: string): Promise<PasswordsSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, seen, one, all, text } = kit
  await kit.openSettings('browser')
  const block = await until('已保存的密码取到', () => {
    const found = one('.set-content [data-passwords]')
    return found && found.dataset.passwords !== 'loading' ? found : null
  })
  const phase = block.dataset.passwords ?? ''
  const rows = () => all('.set-content [data-password]').length
  const count = rows()
  const bridge = (
    window as unknown as { litchBrowser: { passwords: { list(): Promise<object[]> } } }
  ).litchBrowser
  const listed = await bridge.passwords.list()
  const keys = [...new Set(listed.flatMap((one) => Object.keys(one)))].sort()
  const leaked = text(block).includes(sealed) || JSON.stringify(listed).includes(sealed)

  const field = one<HTMLInputElement>('.set-content [data-field="password-search"]')
  const type = (value: string) => {
    if (!field) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  type('BANK')
  await seen(() => rows() === 2, 2000)
  const searchBank = rows()
  type('bank bob')
  await seen(() => rows() === 1, 2000)
  const searchBankBob = rows()
  type('')
  await seen(() => rows() === count, 2000)
  // 有三行时这一块在窗口里的样子：不横向溢出、字读得清
  const look = kit.audit('.set-content [data-passwords]')
  return {
    phase,
    rows: count,
    keys,
    leaked,
    searchBank,
    searchBankBob,
    overflow: look.overflow,
    unreadable: look.unreadable,
  }
}

/** 删一条，再全删（先确认）。接在 passwordsSeen 之后（中间可以截一张图） */
export async function passwordsRemoved(): Promise<PasswordsRemoved> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { seen, one, all, text } = kit
  const rows = () => all('.set-content [data-password]').length
  const count = rows()
  one<HTMLButtonElement>('.set-content [data-act="forget-password"]')?.click()
  await seen(() => rows() === count - 1, 3000)
  const afterRemove = rows()

  one<HTMLButtonElement>('.set-content [data-act="forget-all-passwords"]')?.click()
  const confirmShown = await seen(() => one('dialog.confirm[open]'), 3000)
  one<HTMLButtonElement>('dialog.confirm[open] .confirm-yes')?.click()
  const removedToast = await seen(() => text(one('.toasts')).includes('已删除 2 条密码'), 5000)
  const emptyAfter = await seen(
    () => one('.set-content [data-passwords]')?.dataset.passwords === 'empty',
    3000,
  )
  return { afterRemove, confirmShown, removedToast, emptyAfter }
}

export function judgePasswords(seen: PasswordsSeen, removed: PasswordsRemoved): string[] {
  const failed: string[] = []
  const must = (ok: unknown, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    seen.phase === 'list' && seen.rows === 3,
    `清除浏览数据之后已保存的密码不是三条：${seen.phase} ${seen.rows}`,
  )
  must(
    JSON.stringify(seen.keys) === '["createdAt","id","origin","source","username"]',
    `外壳给界面的密码列表里多了或少了东西：${seen.keys.join(',')}`,
  )
  must(!seen.leaked, '页面上或给界面的列表里出现了加密的密码')
  must(seen.searchBank === 2, `搜“BANK”剩的不是两行：${seen.searchBank}`)
  must(seen.searchBankBob === 1, `搜“bank bob”剩的不是一行：${seen.searchBankBob}`)
  must(seen.overflow.length === 0, `已保存的密码那一块横向溢出：${seen.overflow.join('；')}`)
  must(
    seen.unreadable.length === 0,
    `已保存的密码那一块有读不清的字：${seen.unreadable.join('；')}`,
  )
  must(removed.afterRemove === 2, `删一条之后剩的不是两行：${removed.afterRemove}`)
  must(removed.confirmShown, '点“全部删除”没有先出确认框')
  must(removed.removedToast, '全删之后没有出“已删除 2 条密码”')
  must(removed.emptyAfter, '全删之后不是空的样子')
  return failed
}
