// 接在会话树验收后，用对话里的派出卡片打开已折叠、滚出视口的子会话。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

async function revealProbe() {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return true
      await sleep(50)
    }
    return check()
  }
  const parent = 's6'
  const parentRow = () => $(`[data-session="${parent}"]`)
  parentRow()?.querySelector<HTMLElement>('.ss-row')?.click()
  await until(() => $('.main .tree-card[data-card="spawn"]') !== null)
  const card = [
    ...document.querySelectorAll<HTMLElement>('.main .tree-card[data-card="spawn"]'),
  ].find((entry) => $(`[data-session="${entry.dataset.child}"]`)?.dataset.parent === parent)
  const child = card?.dataset.child
  if (!child) throw new Error('定位验收缺少仍挂在父会话下的派出卡片')
  const childRow = () => $(`[data-session="${child}"]`)
  const scroll = $('.sb-scroll')
  if (!scroll) throw new Error('找不到侧栏滚动区')
  const visible = () => {
    const row = childRow()
    if (!row?.getClientRects().length) return false
    const box = row.getBoundingClientRect()
    const area = scroll.getBoundingClientRect()
    return box.top >= area.top - 1 && box.bottom <= area.bottom + 1
  }
  const openCard = () => $(`.main .tree-card[data-child="${child}"] button.tree-card-main`)?.click()
  const fold = () => parentRow()?.querySelector<HTMLElement>('.tree-fold')
  const collapsed = () => fold()?.getAttribute('aria-expanded') === 'false'
  const chooseParent = async () => {
    parentRow()?.querySelector<HTMLElement>('.ss-row')?.click()
    await until(() => $('.main .tree-card[data-card="spawn"]') !== null)
    await sleep(150)
  }

  // 未读行按产品规则不能折叠隐藏；先读过目标，再回父会话准备折叠场景。
  childRow()?.querySelector<HTMLElement>('.ss-row')?.click()
  await until(() => childRow()?.querySelector('.ss-row.is-unread') === null)
  await chooseParent()
  if (!collapsed()) fold()?.click()
  await sleep(150)
  const hiddenBefore = childRow() === null
  // 从内到外收起项目、项目所在的组、设备；父会话本身也保持折叠。
  const row = parentRow()
  const device = row?.closest('.dev-group')
  for (let block = row?.parentElement; block && block !== device; block = block.parentElement) {
    if (block.hasAttribute('data-group'))
      block
        .querySelector<HTMLElement>(':scope > .head-line .head-toggle[aria-expanded="true"]')
        ?.click()
  }
  device?.querySelector<HTMLElement>(':scope > .row-line .dev-row[aria-expanded="true"]')?.click()
  await sleep(150)
  scroll.scrollTop = scroll.scrollHeight
  const before = scroll.scrollTop
  openCard()
  const expanded = await until(() => visible() && fold()?.getAttribute('aria-expanded') === 'true')
  const external =
    hiddenBefore &&
    expanded &&
    before !== scroll.scrollTop &&
    childRow()?.querySelector('.ss-row[aria-current="true"]') !== null

  // 程序化点击离开视口的树行，可明确检测有没有偷偷触发自动滚动。
  await chooseParent()
  scroll.scrollTop = scroll.scrollHeight
  const directBefore = scroll.scrollTop
  const foldsBefore = JSON.parse(localStorage.getItem('litch.sidebar') ?? '{}').folds
  childRow()?.querySelector<HTMLElement>('.ss-row')?.click()
  await sleep(250)
  const direct =
    scroll.scrollTop === directBefore &&
    JSON.stringify(JSON.parse(localStorage.getItem('litch.sidebar') ?? '{}').folds) ===
      JSON.stringify(foldsBefore)

  // 侧栏关着时打开：不得自己显示，也不得先展开；再打开才完成定位。
  await chooseParent()
  if (!collapsed()) fold()?.click()
  await sleep(150)
  $('.tb-sidebar')?.click()
  await sleep(200)
  openCard()
  await sleep(200)
  const stayedClosed = $('aside.sb')?.hidden === true && collapsed()
  $('.tb-sidebar')?.click()
  const deferred = stayedClosed && (await until(() => visible() && !collapsed()))
  return {
    external,
    direct,
    deferred,
    hiddenBefore,
    expanded,
    before,
    after: scroll.scrollTop,
    child,
  }
}

export async function checkSidebarReveal(window: BrowserWindow) {
  const result = await window.webContents.executeJavaScript(`(${revealProbe.toString()})()`, true)
  const shots = process.env.LITCH_SIDEBAR_REVEAL_SHOTS
  if (shots) {
    await mkdir(shots, { recursive: true })
    await writeFile(
      join(shots, 'M5-sidebar-reveal.png'),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    )
  }
  const failed: string[] = []
  if (!result.external) failed.push('从派出卡打开折叠子会话：展开完整路径、滚到可见并高亮')
  if (!result.direct) failed.push('树内点击不触发定位滚动或展开')
  if (!result.deferred) failed.push('侧栏收起时保留定位，重新打开后展开并滚动')
  return { result, failed }
}
