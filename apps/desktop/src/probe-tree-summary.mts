// 使用独立的示例父会话检查折叠计数，避免后续会话树验收改变这些子会话。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

type Phase = 'spawn' | 'unread' | 'folded' | 'selected' | 'pending' | 'expanded'

async function summaryProbe(phase: Phase) {
  const parent = 's7'
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (check()) return
      await sleep(50)
    }
    throw new Error(`子会话汇总验收等待超时：${phase}`)
  }
  const parentRow = () => $(`[data-session="${parent}"]`)
  const node = () => parentRow()?.closest('.tree-node')
  const kids = () => [...document.querySelectorAll<HTMLElement>(`[data-parent="${parent}"]`)]
  const rows = () => kids().filter((row) => row.classList.contains('row-line'))
  const summary = () => node()?.querySelector<HTMLElement>(':scope > .tree-kids > .tree-sum')
  const fold = () => parentRow()?.querySelector<HTMLElement>('.tree-fold')
  const select = async (row: HTMLElement | null | undefined) => {
    row?.querySelector<HTMLElement>('.ss-row')?.click()
    await sleep(200)
  }
  const setFold = async (shut: boolean) => {
    if ((fold()?.getAttribute('aria-expanded') === 'false') !== shut) fold()?.click()
    await sleep(150)
  }
  const say = async (text: string) => {
    const box = $('.main .dock textarea.cmp-text')
    if (!box) throw new Error('汇总验收找不到输入框')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(80)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  let ok = false
  if (phase === 'spawn') {
    await select(parentRow())
    await say('派子会话')
    await until(() => rows().length === 2 && rows().every((row) => row.querySelector('.is-unread')))
    await setFold(true)
    // 两个都未读时全部露出，不应再有汇总行。
    ok = rows().length === 2 && !summary()
  } else if (phase === 'unread') {
    await select(rows()[0])
    await select(parentRow())
    await setFold(true)
    ok =
      rows().length === 1 &&
      rows()[0]?.querySelector('.is-unread') !== null &&
      summary()?.textContent?.trim() === '还有 1 个子会话'
  } else if (phase === 'folded') {
    await select(rows()[0])
    await select(parentRow())
    await setFold(true)
    ok = rows().length === 0 && summary()?.textContent?.trim() === '2 个子会话'
  } else if (phase === 'selected') {
    summary()?.click()
    await sleep(150)
    await select(rows()[0])
    await setFold(true)
    ok =
      rows().length === 1 &&
      rows()[0]?.querySelector('.ss-row.sel') !== null &&
      summary()?.textContent?.trim() === '还有 1 个子会话'
  } else if (phase === 'pending') {
    await select(parentRow())
    await say('子会话待审批')
    await until(() => rows().some((row) => row.querySelector('.st.wait')))
    ok = rows().length === 1 && summary()?.textContent?.trim() === '还有 2 个子会话'
  } else {
    summary()?.click()
    await sleep(150)
    ok = rows().length === 3 && !summary() && fold()?.getAttribute('aria-expanded') === 'true'
  }
  parentRow()?.scrollIntoView({ block: 'center' })
  return { ok, phase, visible: rows().length, summary: summary()?.textContent?.trim() ?? null }
}

async function summaryLook(skin: string, theme: string) {
  const look = (
    window as unknown as {
      __litchLook: { set(patch: { skin: string; theme: string }): void }
    }
  ).__litchLook
  look.set({ skin, theme })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const row = document.querySelector<HTMLElement>('[data-session="s7"]')
  row?.scrollIntoView({ block: 'center' })
  const node = row?.closest('.tree-node')
  const summary = node?.querySelector<HTMLElement>(':scope > .tree-kids > .tree-sum')
  const box = summary?.getBoundingClientRect()
  const scroll = row?.closest('.sb-scroll')?.getBoundingClientRect()
  const style = summary ? getComputedStyle(summary) : null
  const kids = node?.querySelector<HTMLElement>(':scope > .tree-kids')
  const guide = kids ? getComputedStyle(kids, '::before') : null
  return {
    look: `${skin}/${theme}`,
    ok:
      guide?.borderLeftStyle === 'solid' &&
      (!summary ||
        (!!box &&
          !!scroll &&
          box.height > 0 &&
          box.top >= scroll.top &&
          box.bottom <= scroll.bottom &&
          box.right <= scroll.right &&
          summary.scrollWidth <= summary.clientWidth + 1 &&
          style?.color !== style?.backgroundColor)),
  }
}

export async function checkTreeSummary(window: BrowserWindow) {
  const inPage = async <T, A extends unknown[]>(fn: (...args: A) => Promise<T>, ...args: A) =>
    (await window.webContents.executeJavaScript(
      `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
      true,
    )) as T
  const shots = process.env.LITCH_TREE_SUMMARY_SHOTS
  if (shots) await mkdir(shots, { recursive: true })
  const states = []
  const looks = []
  const failed: string[] = []
  for (const phase of ['spawn', 'unread', 'folded', 'selected', 'pending', 'expanded'] as const) {
    const state = await inPage(summaryProbe, phase)
    states.push(state)
    if (!state.ok) failed.push(`子会话汇总 ${phase}：${JSON.stringify(state)}`)
    if (phase !== 'unread' && phase !== 'folded' && phase !== 'expanded') continue
    for (const skin of ['retro', 'human', 'standard']) {
      for (const theme of ['light', 'dark']) {
        const look = await inPage(summaryLook, skin, theme)
        looks.push({ phase, ...look })
        if (!look.ok) failed.push(`子会话汇总布局 ${phase} ${look.look}`)
        if (shots)
          await writeFile(
            join(shots, `M17-${skin}-${theme}-${phase}.png`),
            (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
          )
      }
    }
  }
  return { states, looks, failed }
}
