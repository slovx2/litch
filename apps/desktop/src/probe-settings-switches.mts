// 设置页“按 harness 开关”那棵树的验收（设置页验收头一遍的一段）：设置里停用的 harness 不列，
// 设备那一格不算它，点设备那一格设整列也不动它的值；到设备详情里启用之后它出现在树上，原来的值照旧。
// 只对着模拟核心：build-01 上的 Gemini CLI 一开始停用着，任务卡关着（sample-data.mts、sample-manage.mts）。
import type { SettingsKit } from './probe-settings-kit.mjs'

export interface SwitchesSeen {
  /** build-01 下面列出来的 harness（启用前、启用后） */
  rowsBefore: string[]
  rowsAfter: string[]
  /** build-01 那一行的格子：任务卡、浏览器（启用前、点了浏览器那一格之后、启用后） */
  cardsBefore: string
  browserBefore: string
  browserFlipped: string
  cardsAfter: string
  browserAfter: string
  /** 启用后 Gemini CLI 那一行：任务卡、浏览器 */
  openCards: string
  openBrowser: string
  /** 收尾把浏览器那一格点回全开之后 */
  browserRestored: string
}

export async function switchesSeen(): Promise<SwitchesSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, seen, one, all } = kit
  const body = () => one('[data-slot="harness-switches-table"] tbody[data-device="build"]')
  const rows = () =>
    all('tr.hsw-harness', body() ?? document.createElement('tbody')).map(
      (row) => row.dataset.harness ?? '?',
    )
  const cell = (harness: string | null, column: string) => {
    const row = harness === null ? 'tr.hsw-device' : `tr.hsw-harness[data-harness="${harness}"]`
    return one(`${row} td[data-col="${column}"] [data-state]`, body() ?? document)
  }
  const state = (harness: string | null, column: string) =>
    cell(harness, column)?.dataset.state ?? '没有'
  const openTree = async () => {
    await kit.openSettings('switches')
    // 任务卡的现值要等设备设置读到
    await until('build-01 的任务卡读到', () => body() && state(null, 'taskCards') !== 'unknown')
  }

  await openTree()
  const rowsBefore = rows()
  const cardsBefore = state(null, 'taskCards')
  const browserBefore = state(null, 'browser')
  ;(cell(null, 'browser') as HTMLInputElement | null)?.click()
  await seen(() => state(null, 'browser') !== browserBefore, 3000)
  const browserFlipped = state(null, 'browser')

  // ---- 到设备详情里启用 Gemini CLI ----
  one<HTMLButtonElement>('.set-go[data-page="devices"]')?.click()
  const item = await until('设备页里的 build-01', () => one('.devp-item[data-device="build"]'))
  one<HTMLButtonElement>('.devp-row', item)?.click()
  await until('build-01 的设置', () => one('[data-detail="build"] [data-manage-state="ready"]'))
  const block = () => one('[data-harness-block="gemini"]')
  await until('Gemini CLI 那一块是停用的', () => block()?.dataset.state === 'disabled')
  one<HTMLButtonElement>('.mng-h-head [data-lead] .switch', block() ?? document)?.click()
  const save = await until('能按的“保存”', () => {
    const found = one<HTMLButtonElement>('.mng-save [data-act="save"]')
    return found && !found.disabled ? found : null
  })
  save.click()
  await until('Gemini CLI 启用了', () => block()?.dataset.state === 'ready')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await seen(() => !one('.devp[data-detail]'), 2000)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await seen(() => !one('.devp'), 2000)

  await openTree()
  await until('树上出现 Gemini CLI', () => rows().includes('gemini'))
  const seenAfter = {
    rowsAfter: rows(),
    cardsAfter: state(null, 'taskCards'),
    browserAfter: state(null, 'browser'),
    openCards: state('gemini', 'taskCards'),
    openBrowser: state('gemini', 'browser'),
  }
  ;(cell(null, 'browser') as HTMLInputElement | null)?.click()
  await seen(() => state(null, 'browser') === 'on', 3000)
  return {
    rowsBefore,
    cardsBefore,
    browserBefore,
    browserFlipped,
    ...seenAfter,
    browserRestored: state(null, 'browser'),
  }
}

/** 这一段的判定 */
export function judgeSwitches(seen: SwitchesSeen): string[] {
  const failed: string[] = []
  const same = (actual: unknown, expected: unknown, what: string) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failed.push(`${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`)
    }
  }
  same(
    seen.rowsBefore,
    ['claude', 'pi', 'dsh', 'codex', 'opencode'],
    '停用 Gemini CLI 时 build-01 下面列的',
  )
  same(seen.cardsBefore, 'on', '停用的 Gemini CLI 任务卡关着，设备那一格却不是全开')
  same(seen.browserBefore, 'on', '浏览器那一格一开始')
  same(seen.browserFlipped, 'off', '点了浏览器那一格之后')
  same(
    seen.rowsAfter,
    ['claude', 'pi', 'dsh', 'codex', 'opencode', 'gemini'],
    '启用 Gemini CLI 之后 build-01 下面列的',
  )
  same(seen.openCards, 'off', '启用后 Gemini CLI 的任务卡（原来关着）')
  same(seen.openBrowser, 'on', '启用后 Gemini CLI 的浏览器（停用时点设备那一格不该动它）')
  same(seen.cardsAfter, 'mixed', '启用后设备那一格的任务卡')
  same(seen.browserAfter, 'mixed', '启用后设备那一格的浏览器')
  same(seen.browserRestored, 'on', '把浏览器那一格点回去之后')
  return failed
}
