// --tasks 的侧栏回归：小钟独立于行按钮，真实鼠标/键盘进入正确任务，六套外观不挤占行尾。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

async function prepare(skin: string, theme: string, kind: string) {
  const wait = () =>
    new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  // 上一轮打开的是模态任务窗口，先经关闭按钮恢复侧栏的键盘可达性。
  document
    .querySelector<HTMLButtonElement>('[data-page-window="tasks"] .arch-head > button:last-child')
    ?.click()
  await wait()
  const look = (
    window as unknown as { __litchLook: { set(p: { skin: string; theme: string }): void } }
  ).__litchLook
  look.set({ skin, theme })
  await wait()
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(`button.task-mark[data-task-mark="${kind}"]`),
  ].find((b) => b.getClientRects().length > 0)
  if (!button) throw Error(`没有 ${kind} 定时任务小钟`)
  button.scrollIntoView({ block: 'center' })
  await wait()
  button.focus()
  const row = button.parentElement
  const select = row?.querySelector<HTMLButtonElement>('.ss-row')
  const slot = select?.querySelector<HTMLElement>('.task-mark-slot')
  const chipNode = select?.querySelector('.chip')
  const titleNode = select?.querySelector('.title')
  const taskId = button.dataset.task
  if (!select || !slot || !chipNode || !titleNode || !taskId)
    throw Error('定时任务行缺少布局或任务号')
  const box = button.getBoundingClientRect()
  const place = slot.getBoundingClientRect()
  const chip = chipNode.getBoundingClientRect()
  const bounds = select.getBoundingClientRect()
  const title = titleNode.getBoundingClientRect()
  const selected = () =>
    [...document.querySelectorAll('.ss-row[aria-current="true"]')]
      .map((r) => r.closest('.row-line')?.getAttribute('data-session'))
      .join('|')
  const ticks = [...document.querySelectorAll<HTMLElement>('.ss-row > .dev-tick')]
  return {
    sidebarWidth: document.querySelector('.sb')?.getBoundingClientRect().width,
    id: taskId,
    selected: selected(),
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
    aligned:
      Math.abs(box.x - place.x) < 1 &&
      Math.abs(box.y - place.y) < 1 &&
      box.width >= 20 &&
      box.height >= 20 &&
      box.top >= bounds.top - 1 &&
      box.bottom <= bounds.bottom + 1 &&
      title.right <= box.left + 1 &&
      box.right <= chip.left + 1,
    accessible:
      button.tabIndex === 0 &&
      document.activeElement === button &&
      button.title.includes('查看任务') &&
      button.getAttribute('aria-label') === button.title &&
      !select.contains(button),
    deviceNamesHidden:
      ticks.length > 0 &&
      ticks.every(
        (tick) => !!tick.title && !tick.parentElement?.querySelector('.projection-device'),
      ),
  }
}

async function landed(id: string, selected: string) {
  for (let i = 0; i < 100; i++) {
    const page = document.querySelector(`[data-tasks="detail"][data-task="${id}"]`)
    if (page?.querySelector('[data-task-name]')) {
      const after = [...document.querySelectorAll('.ss-row[aria-current="true"]')]
        .map((r) => r.closest('.row-line')?.getAttribute('data-session'))
        .join('|')
      return after === selected
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

export async function checkSidebarTaskLinks(window: BrowserWindow) {
  const evaluate = <T, A extends unknown[]>(
    fn: (...args: A) => Promise<T>,
    ...args: A
  ): Promise<T> =>
    window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true)
  const debuggerOwned = !window.webContents.debugger.isAttached()
  if (debuggerOwned) window.webContents.debugger.attach('1.3')
  const key = async (name: string, code: number, modifiers = 0) => {
    const params = { key: name, code: name, windowsVirtualKeyCode: code, modifiers }
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...params,
      ...(name === 'Enter' ? { text: '\r' } : {}),
    })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...params,
    })
  }
  const failed: string[] = []
  const rows: unknown[] = []
  const previous = await window.webContents.executeJavaScript(
    '({skin:document.documentElement.dataset.skin,theme:document.documentElement.dataset.theme})',
  )
  const [originalWidth = 1200, originalHeight = 800] = window.getSize()
  try {
    // 普通/窄窗口，既看运行来源，也看固定目标的小钟。
    for (const width of [1200, 900]) {
      window.setSize(width, 800)
      if (width === 900)
        await window.webContents.executeJavaScript(`(() => {
        const grip = document.querySelector('.sb-grip');
        for (let i = 0; i < 12; i++) grip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      })()`)
      for (const skin of ['retro', 'human', 'standard'])
        for (const theme of ['light', 'dark']) {
          const kind = theme === 'light' ? 'run' : 'target'
          const row = await evaluate(prepare, skin, theme, kind)
          rows.push({ width, skin, theme, ...row })
          for (const key of ['aligned', 'accessible', 'deviceNamesHidden'] as const)
            if (!row[key]) failed.push(`${width}/${skin}/${theme} ${key}`)
          const shots = process.env.LITCH_FIXTURE_SIDEBAR_TASK_SHOTS
          if (shots && width === 900) {
            mkdirSync(shots, { recursive: true })
            writeFileSync(
              join(shots, `${skin}-${theme}.png`),
              (await window.webContents.capturePage()).toPNG(),
            )
          }
          if (theme === 'light') {
            window.webContents.sendInputEvent({
              type: 'mouseDown',
              x: row.x,
              y: row.y,
              button: 'left',
              clickCount: 1,
            })
            window.webContents.sendInputEvent({
              type: 'mouseUp',
              x: row.x,
              y: row.y,
              button: 'left',
              clickCount: 1,
            })
          } else {
            await key('Tab', 9, 8)
            await key('Tab', 9)
            const focused = await window.webContents.executeJavaScript(
              'document.activeElement?.matches(":focus-visible") ? document.activeElement.getAttribute("data-task") : null',
            )
            if (focused !== row.id)
              failed.push(`${width}/${skin}/${theme} Tab 未到小钟：${focused}`)
            await key('Enter', 13)
          }
          if (!(await evaluate(landed, row.id, row.selected)))
            failed.push(`${width}/${skin}/${theme} 未直达任务或误开会话`)
        }
    }
  } finally {
    if (debuggerOwned) window.webContents.debugger.detach()
    window.setSize(originalWidth, originalHeight)
    await window.webContents.executeJavaScript(
      `window.__litchLook.set(${JSON.stringify(previous)})`,
    )
  }
  return { rows, failed }
}
