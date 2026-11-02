import type { BrowserWindow } from 'electron'

/** 只在隔离冒烟窗口里给最近组放一项；重载后用正式行组件验证副本选中。 */
export async function checkSidebarSelection(window: BrowserWindow) {
  await window.webContents.executeJavaScript(`(() => {
    localStorage.setItem('litch.sidebar.activity', JSON.stringify([
      {deviceId:'local', sessionId:'s3', at:Date.now()},
      {deviceId:'local', sessionId:'manager-k1', at:Date.now()-1000}
    ]));
    const sidebar = JSON.parse(localStorage.getItem('litch.sidebar') || '{}');
    localStorage.setItem('litch.sidebar', JSON.stringify({...sidebar, open:true, harnesses:[], folds:{}}));
  })()`)
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once('did-finish-load', () => resolve()),
  )
  window.webContents.reload()
  await loaded
  return window.webContents.executeJavaScript(`(${selectionSeen.toString()})()`, true)
}

async function selectionSeen() {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return
      await sleep(25)
    }
    throw new Error('侧栏单行选中验收超时')
  }
  const recent = () =>
    document.querySelector<HTMLButtonElement>('[data-projection=recent] [data-session=s3] .ss-row')
  const tree = () =>
    document.querySelector<HTMLButtonElement>(
      '.dev-group[data-device=local] [data-session=s3] .ss-row',
    )
  await until(() => !!recent() && !!tree())
  const only = (row: HTMLElement | null) => {
    const selected = [...document.querySelectorAll('.ss-row.sel')]
    const current = [...document.querySelectorAll('.ss-row[aria-current="true"]')]
    return (
      selected.length === 1 && current.length === 1 && selected[0] === row && current[0] === row
    )
  }
  recent()?.click()
  await until(() => only(recent()))
  document.querySelector<HTMLButtonElement>('[data-sidebar-mode=manager]')?.click()
  await until(() => !document.querySelector('[data-projection]'))
  document.querySelector<HTMLButtonElement>('[data-sidebar-mode=chat]')?.click()
  await until(() => !!recent())
  await until(() => only(recent()))
  tree()?.click()
  await until(() => only(tree()))
  recent()?.click()
  await until(() => only(recent()))
  const manager = () =>
    document.querySelector<HTMLButtonElement>('[data-projection=recent] [data-session=m1] .ss-row')
  await until(() => !!manager())
  if (document.querySelector('[data-projection=recent] [data-session=manager-k1]'))
    throw new Error('工作线应默认收在经理下')
  manager()?.click()
  await until(
    () =>
      document.querySelector('[data-sidebar-mode=manager]')?.getAttribute('aria-pressed') ===
      'true',
  )
  if (document.querySelector('[data-projection]')) throw new Error('经理模式不应显示投影组')
  document.querySelector<HTMLButtonElement>('[data-sidebar-mode=chat]')?.click()
  await until(() => only(manager()))
  return { recentOnly: true, treeOnly: true, modeRestored: true, managerEntry: true }
}
