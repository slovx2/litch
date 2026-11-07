/** 隐藏窗口：用正式按钮和键盘事件走导航、模态框与定位开关。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { NOTIFY_CLICK } from './ipc.mjs'

export async function navigationProbe() {
  const failed: string[] = []
  const must = (ok: boolean, text: string) => {
    if (!ok) failed.push(text)
  }
  const sleep = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
  const one = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)
  const until = async (check: () => unknown) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return
      await sleep(25)
    }
    throw new Error(`导航验收超时：${document.querySelector('.main')?.textContent?.slice(0, 120)}`)
  }
  const click = async (selector: string) => {
    await until(() => one(selector))
    one<HTMLElement>(selector)?.click()
    await sleep()
  }
  const blur = () => (document.activeElement as HTMLElement | null)?.blur()
  const picked = () =>
    one('.ss-row.sel:not(.projection-group *, .sc-group *)')?.closest<HTMLElement>('[data-session]')
      ?.dataset.session ?? null
  const key = async (key: string, init: KeyboardEventInit = {}) => {
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
    await sleep()
  }
  const mac = document.documentElement.dataset.platform === 'mac'
  const back = async () => {
    blur()
    await key(mac ? '[' : 'ArrowLeft', mac ? { metaKey: true } : { altKey: true })
  }
  const forward = async () => {
    blur()
    await key(mac ? ']' : 'ArrowRight', mac ? { metaKey: true } : { altKey: true })
  }
  const rect = () => {
    const r = one('.window-navigation')!.getBoundingClientRect()
    return [r.x, r.y, r.width, r.height].join(',')
  }
  await until(
    () => document.querySelectorAll('.ss-row:not(.projection-group *, .sc-group *)').length > 3,
  )
  const origin = rect()
  must(
    one<HTMLButtonElement>('[data-navigation="back"]')?.disabled === true,
    '新建页启动时后退未禁用',
  )
  const rows = [
    ...document.querySelectorAll<HTMLElement>('.ss-row:not(.projection-group *, .sc-group *)'),
  ].filter((row) => row.closest('[data-session]'))
  const a = rows[0]!
  const b = rows[1]!
  a.click()
  await sleep()
  const aId = picked()
  b.click()
  await sleep()
  const bId = picked()
  await back()
  must(picked() === aId, '快捷键后退未回第一个会话')
  await forward()
  must(picked() === bId, '快捷键前进未回第二个会话')
  const editor = one<HTMLTextAreaElement>('.main textarea')
  editor?.focus()
  await key(mac ? '[' : 'ArrowLeft', mac ? { metaKey: true } : { altKey: true })
  must(picked() === bId, '输入框焦点下误触导航')
  blur()
  await key(mac ? '[' : 'ArrowLeft', {
    ...(mac ? { metaKey: true } : { altKey: true }),
    isComposing: true,
  })
  must(picked() === bId, '输入法组字误触导航')
  document.body.dispatchEvent(
    new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true }),
  )
  await sleep()
  must(picked() === aId, '鼠标后退未导航')
  blur()
  document.body.dispatchEvent(
    new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true }),
  )
  await sleep()
  must(picked() === bId, '鼠标前进未导航')
  must(rect() === origin, '切换会话后导航按钮位置变化')

  for (const kind of ['settings', 'suggestions', 'tasks']) {
    const selector = kind === 'settings' ? '.sb-settings' : `.sb-btn.${kind}`
    const opener = one<HTMLElement>(selector)!
    opener.focus()
    opener.click()
    await until(() => one('.page-window:modal'))
    const modal = one<HTMLDialogElement>('.page-window')!
    const before = picked()
    must(modal.dataset.pageWindow === kind, `${kind} 未进入模态层`)
    must(modal.contains(document.activeElement), `${kind} 打开后焦点未进入窗口`)
    // 设置固定大小（左右两栏切换不跳）；建议、定时任务按内容定高
    must(modal.hasAttribute('data-fit') === (kind !== 'settings'), `${kind} 窗口定高方式不对`)
    if (kind === 'settings')
      must(
        document.activeElement?.getAttribute('aria-current') === 'page',
        '设置打开后初始焦点不在当前分区',
      )
    if (kind === 'suggestions' && modal.querySelector('.page-empty'))
      must(
        modal.getBoundingClientRect().height <= 300 &&
          !modal.querySelector('h1 .pill') &&
          (() => {
            // 空状态在窗口里居中
            const box = modal.getBoundingClientRect()
            const empty = modal.querySelector('.page-empty p')?.getBoundingClientRect()
            return !!empty && Math.abs(empty.x + empty.width / 2 - (box.x + box.width / 2)) <= 2
          })(),
        '没有建议时窗口没收矮、空状态没居中，或标题旁仍写 0',
      )
    one<HTMLElement>('.sb-link.new')?.focus()
    must(modal.contains(document.activeElement), `${kind} 允许焦点移到背景`)
    await back()
    must(picked() === before, `${kind} 打开时快捷键切了主界面`)
    opener.click()
    await sleep()
    must(document.querySelectorAll('.page-window').length === 1, `${kind} 重复打开创建了多个窗口`)
    must(
      !one('.main .set-page') &&
        !one('.main [data-tasks]') &&
        !one('.main [data-page="suggestions"]'),
      `${kind} 仍占主区域`,
    )
    must(rect() === origin, `${kind} 打开时导航位置变化`)
    modal.querySelector<HTMLElement>('button')?.focus()
    await key('Escape')
    await until(() => !one('.page-window'))
    must(picked() === before, `${kind} 关闭后丢失主会话`)
    must(document.activeElement === opener, `${kind} 关闭后未恢复打开前的焦点`)
  }
  // 鼠标打开设置：初始焦点不画框，按了键再画；键盘打开照常画
  {
    const opener = one<HTMLElement>('.sb-settings')!
    opener.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    opener.click()
    await until(() => one('.page-window:modal'))
    const modal = one<HTMLDialogElement>('.page-window')!
    const active = document.activeElement as HTMLElement
    must(
      modal.hasAttribute('data-quiet-focus') &&
        active.getAttribute('aria-current') === 'page' &&
        getComputedStyle(active).outlineStyle === 'none',
      '鼠标打开设置后初始焦点仍画了焦点框，或焦点不在当前分区',
    )
    await key('ArrowDown')
    must(!modal.hasAttribute('data-quiet-focus'), '鼠标打开后按键没有恢复焦点框')
    await key('Escape')
    await until(() => !one('.page-window'))
    opener.focus()
    await key('Shift')
    opener.click()
    await until(() => one('.page-window:modal'))
    must(!one('.page-window')?.hasAttribute('data-quiet-focus'), '键盘打开设置时去掉了焦点框')
    await key('Escape')
    await until(() => !one('.page-window'))
  }
  // 模态开关不入历史：仍能一步回到 a。
  await back()
  must(picked() === aId, '模态开关污染导航历史')
  await forward()
  await click('[data-sidebar-mode="manager"]')
  must(
    one('.cmp-text')?.getAttribute('data-composer-session') === JSON.stringify(['local', bId]),
    '切导航树改变了主对话',
  )
  await click('.mg-sidebar-group header .ibtn')
  must(rect() === origin, '经理标题栏的导航按钮发生移动')
  await back()
  must(
    one('[data-sidebar-mode="manager"]')?.getAttribute('aria-pressed') === 'true',
    '内容后退改变了导航树',
  )
  await click('[data-sidebar-mode="chat"]')
  must(picked() === bId, '经理页未进入历史')

  // 设备列表与详情留在设置模态；归档入口才会跳到主窗口并进入历史。
  await click('.sb-settings')
  await click('.set-go[data-page="devices"]')
  await until(() => one('.page-window .devp-list'))
  must(!one('.main .devp') && !!one('.page-window:modal .devp'), '设备列表没有并入设置窗口')
  await click('.page-window .devp-row')
  await until(() => one('.page-window [data-detail]'))
  must(!!one('.page-window .set-nav') && picked() === bId, '设备详情丢失设置导航或替换了主对话')
  await click('.page-window .devp .arch-head .ibtn:last-child')
  await until(() => !one('.page-window'))
  await back()
  must(picked() === aId, '设备窗口污染了主导航历史')
  await forward()
  await click('.sb-settings')
  await click('.set-go[data-page="archived"]')
  must(!one('.page-window') && !!one('.main .arch-page'), '归档链接未关闭窗口并进入主页面')
  await back()
  must(picked() === bId, '归档链接未进入历史')
  await click('.sb-link.new')
  must(
    one<HTMLButtonElement>('[data-navigation="forward"]')?.disabled === true,
    '后退后新导航没有截断前进记录',
  )

  // 关闭定位后从历史打开折叠设备里的对话，不展开、不滚动；打开后立即定位当前对话。
  const again = one<HTMLElement>(
    `[data-session="${aId}"]:not(.projection-group *, .sc-group *) .ss-row`,
  )!
  again.click()
  await sleep()
  await click('.sb-link.new')
  await click('.sb-more > button')
  const option = one<HTMLButtonElement>('[data-option="autoLocate"]')!
  must(option.getAttribute('aria-checked') === 'true', '自动定位默认未打开')
  // “更多”菜单：标题和说明左对齐，紧跟勾选列（量文字的位置，不看样式）
  for (const item of document.querySelectorAll<HTMLElement>('.sb-more .pick-opt')) {
    const mark = item.querySelector('.pick-mark')!.getBoundingClientRect()
    const title = document.createRange()
    title.selectNodeContents(item.querySelector('b')!)
    const text = [...title.getClientRects()].filter((r) => r.left >= mark.right - 1)
    const left = Math.min(...text.map((r) => r.left))
    const noteNode = item.querySelector(':scope > span')
    const noteRange = document.createRange()
    if (noteNode) noteRange.selectNodeContents(noteNode)
    const note = noteNode ? Math.min(...[...noteRange.getClientRects()].map((r) => r.left)) : null
    must(
      left - mark.right <= 8 && (note === null || Math.abs(note - left) <= 2),
      `“更多”菜单的 ${item.dataset.option} 没有紧跟勾选列左对齐`,
    )
  }
  option.click()
  await sleep()
  await click('.sb-more > button')
  const device = again.closest('.dev-group')!
  const toggle = device.querySelector<HTMLElement>(
    ':scope > .row-line .dev-row[aria-expanded="true"]',
  )
  toggle?.click()
  await sleep()
  const scroll = one<HTMLElement>('.sb-scroll')!
  scroll.scrollTop = scroll.scrollHeight
  const scrollBefore = scroll.scrollTop
  const folds = localStorage.getItem('litch.sidebar')
  await back()
  must(picked() === null || picked() === aId, '关闭定位后未保留正确会话选择')
  must(scroll.scrollTop === scrollBefore, '关闭定位后历史导航仍滚动侧栏')
  must(localStorage.getItem('litch.sidebar') === folds, '关闭定位后历史导航仍展开分组')
  await click('.sb-more > button')
  await click('[data-option="autoLocate"]')
  await click('.sb-more > button')
  await until(() => picked() === aId)
  must(
    device.querySelector('.dev-row')?.getAttribute('aria-expanded') === 'true',
    '开启定位后未展开设备',
  )
  return { failed, fixedPosition: origin, first: aId, second: bId }
}

export async function runNavigationChecks(
  window: BrowserWindow,
): Promise<readonly [object, string[]]> {
  const result = await window.webContents.executeJavaScript(
    `(${navigationProbe.toString()})()`,
    true,
  )
  const size = window.getSize()
  window.setSize(900, 560)
  const narrow = await window.webContents.executeJavaScript(
    `(${async () => {
      const sleep = () => new Promise((resolve) => setTimeout(resolve, 120))
      const failed: string[] = []
      const sizes: string[] = []
      for (const kind of ['settings', 'suggestions', 'tasks']) {
        document
          .querySelector<HTMLElement>(kind === 'settings' ? '.sb-settings' : `.sb-btn.${kind}`)
          ?.click()
        await sleep()
        const modal = document.querySelector<HTMLDialogElement>('.page-window')
        if (!modal) {
          failed.push(`${kind} 窄窗未打开`)
          continue
        }
        const b = modal.getBoundingClientRect()
        sizes.push(`${kind}:${b.width}×${b.height}`)
        if (
          b.left < 0 ||
          b.top < 0 ||
          b.right > innerWidth ||
          b.bottom > innerHeight ||
          modal.scrollWidth > modal.clientWidth + 1
        )
          failed.push(`${kind} 窄窗口溢出`)
        modal.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
        await sleep()
      }
      document.querySelector<HTMLElement>('.sb-settings')?.click()
      await sleep()
      document.querySelector<HTMLElement>('.page-window button')?.focus()
      return { failed, sizes }
    }})()`,
    true,
  )
  // 真键盘输入验证浏览器的原生模态焦点约束。
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
  const trapped = await window.webContents.executeJavaScript(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector('.page-window')?.contains(document.activeElement)))))`,
  )
  if (!trapped) result.failed.push('Shift+Tab 离开模态窗口')
  const shots = process.env.LITCH_NAVIGATION_SHOTS
  if (shots) {
    await mkdir(shots, { recursive: true })
    await writeFile(
      join(shots, 'settings-narrow.png'),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    )
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  for (const enabled of [false, true]) {
    const prepare = await window.webContents.executeJavaScript(
      `(${async (enabled: boolean, id: string) => {
        const sleep = () => new Promise((resolve) => setTimeout(resolve, 150))
        await sleep()
        const one = (selector: string) => document.querySelector<HTMLElement>(selector)
        one('.sb-more > button')?.click()
        await sleep()
        const option = one('[data-option="autoLocate"]')
        if ((option?.getAttribute('aria-checked') === 'true') !== enabled) option?.click()
        one('.sb-more > button')?.click()
        await sleep()
        const row = one(`[data-session="${id}"]:not(.projection-group *, .sc-group *)`)
        const device = row?.closest<HTMLElement>('.dev-group')
        const deviceId = device?.dataset.device
        device
          ?.querySelector<HTMLElement>(':scope > .row-line .dev-row[aria-expanded="true"]')
          ?.click()
        await sleep()
        const scroll = one('.sb-scroll')
        if (scroll) scroll.scrollTop = scroll.scrollHeight
        return { deviceId, folds: localStorage.getItem('litch.sidebar'), scroll: scroll?.scrollTop }
      }})(${enabled}, ${JSON.stringify(result.first)})`,
      true,
    )
    if (!prepare.deviceId) {
      result.failed.push('通知定位夹具缺少设备标识')
      continue
    }
    // 走和操作系统通知点击相同的预加载事件；不创建真实系统通知。
    window.webContents.send(
      NOTIFY_CLICK,
      `session:${JSON.stringify([prepare.deviceId, result.first, 'turn'])}`,
    )
    const located = await window.webContents.executeJavaScript(
      `(${async (enabled: boolean, id: string, before: { folds: string; scroll: number }) => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (!enabled)
          return (
            before.folds === localStorage.getItem('litch.sidebar') &&
            before.scroll === document.querySelector('.sb-scroll')?.scrollTop
          )
        const row = document.querySelector(
          `[data-session="${id}"]:not(.projection-group *, .sc-group *) .ss-row`,
        )
        return row?.getAttribute('aria-current') === 'true' && !!row.getClientRects().length
      }})(${enabled}, ${JSON.stringify(result.first)}, ${JSON.stringify(prepare)})`,
      true,
    )
    if (!located) result.failed.push(`通知打开未遵守自动定位${enabled ? '开' : '关'}设置`)
  }
  window.setSize(size[0] ?? 1360, size[1] ?? 860)
  return [{ ...result, narrow, trapped }, [...result.failed, ...narrow.failed]]
}
