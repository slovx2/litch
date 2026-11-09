import type { BrowserWindow } from 'electron'
import type {
  CommandName,
  Commands,
  SessionSummary,
  SidebarView,
} from '../../../packages/core/src/index.mjs'

/** 仅运行于隔离的模拟核心窗口；用正式命令建立跨项目父子关系，再从真实行点击清未读。 */
export async function checkSidebarUnread(window: BrowserWindow) {
  if (window.isVisible()) throw new Error('未读验收只允许隐藏窗口')
  await window.webContents.executeJavaScript(`localStorage.removeItem('litch.sidebar')`)
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once('did-finish-load', () => resolve()),
  )
  window.webContents.reload()
  await loaded
  return window.webContents.executeJavaScript(`(${unreadSeen.toString()})()`, true)
}

async function unreadSeen() {
  const until = async (what: string, check: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`未读验收超时：${what}`)
  }
  const port = await new Promise<MessagePort>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'litch:core-port' || !event.ports[0])
        return
      window.removeEventListener('message', receive)
      resolve(event.ports[0])
    }
    window.addEventListener('message', receive)
    ;(window as unknown as { litchShell: { requestCorePort(): void } }).litchShell.requestCorePort()
  })
  let seq = 1
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const sessions = new Map<string, SessionSummary>()
  port.onmessage = ({ data }) => {
    if (data.t === 'res') {
      const entry = pending.get(data.id)
      pending.delete(data.id)
      if (data.ok) entry?.resolve(data.result)
      else entry?.reject(new Error(JSON.stringify(data.error)))
    } else if (data.t === 'snap') {
      for (const summary of (data.data as SidebarView).sessions) sessions.set(summary.id, summary)
    } else if (data.t === 'delta') {
      for (const op of data.ops)
        if (op.op === 'session.upsert') sessions.set(op.session.id, op.session)
    }
  }
  const command = <K extends CommandName>(name: K, params: Commands[K]['params']) =>
    new Promise<Commands[K]['result']>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve: (value) => resolve(value as Commands[K]['result']), reject })
      port.postMessage({ t: 'cmd', id, name, params })
    })
  port.postMessage({ t: 'sub', id: 1, topic: { kind: 'sidebar', deviceId: 'local' } })
  try {
    await until('侧栏快照', () => sessions.has('s6'))
    const { workspaceId: source } = await command('workspace.create', {
      deviceId: 'local',
      name: '未读来源项目',
      root: '/fixture/unread-source',
    })
    const { workspaceId: destination } = await command('workspace.create', {
      deviceId: 'local',
      name: '父树显示项目',
      root: '/fixture/unread-destination',
    })
    await command('session.move', { deviceId: 'local', sessionId: 's6', workspaceId: destination })
    const { sessionId: child } = await command('session.spawn', {
      deviceId: 'local',
      parentId: 's6',
      workspaceId: source,
      kind: 'fresh',
      title: '跨项目未读子会话',
      prompt: '完成未读验收',
      wakeParent: false,
    })
    await until('子会话完成并未读', () => sessions.get(child)?.unread === true)
    const group = (id: string) =>
      document.querySelector(`.dev-group[data-device=local] [data-group="${id}"]`)
    const row = () =>
      group(destination)?.querySelector<HTMLButtonElement>(`[data-session="${child}"] .ss-row`)
    const fold = async (id: string, open: boolean) => {
      const button = group(id)?.querySelector<HTMLButtonElement>('.ws-row[aria-expanded]')
      if (!button) throw new Error('找不到项目组头')
      if ((button.getAttribute('aria-expanded') === 'true') !== open) button.click()
      await until('组头开合', () => button.getAttribute('aria-expanded') === String(open))
    }
    const count = (id: string) =>
      Number(group(id)?.querySelector<HTMLElement>('.tally')?.dataset.unread ?? 0)
    await until('子项挂在父树', () => !!row())
    if (group(source)?.querySelector(`[data-session="${child}"]`)) throw new Error('子会话重复显示')
    await fold(source, false)
    await fold(destination, false)
    await until('显示项目计未读', () => count(destination) === 1)
    if (count(source) !== 0) throw new Error('来源项目出现幽灵未读')
    await fold(destination, true)
    await until('重新展开可点到未读', () => !!row()?.classList.contains('is-unread'))
    const parent = group(destination)?.querySelector<HTMLButtonElement>('[data-session=s6] .ss-row')
    parent?.click()
    await until('父会话已打开', () => !!parent?.classList.contains('sel'))
    if (!sessions.get(child)?.unread) throw new Error('打开父项错误地清除了子项未读')
    row()?.click()
    await until('点击子项清未读', () => sessions.get(child)?.unread === false)
    await fold(destination, false)
    await until('已读后组头归零', () => count(destination) === 0)
    if (count(source) !== 0) throw new Error('清未读后来源项目仍有计数')
    const { sessionId: nested } = await command('session.spawn', {
      deviceId: 'local',
      parentId: 's6',
      kind: 'fresh',
      title: '菜单未读子线',
      prompt: '完成',
      wakeParent: false,
    })
    await until('菜单子线未读', () => sessions.get(nested)?.unread === true)
    const { sessionId: grandchild } = await command('session.spawn', {
      deviceId: 'local',
      parentId: nested,
      kind: 'fresh',
      title: '菜单未读孙线',
      prompt: '完成',
      wakeParent: false,
    })
    await until('菜单孙线未读', () => sessions.get(grandchild)?.unread === true)
    await fold(destination, true)
    const selectionBefore = document
      .querySelector('.ss-row.sel')
      ?.closest('[data-session]')
      ?.getAttribute('data-session')
    const otherUnread = [...sessions.values()]
      .filter((s) => s.unread && !['s6', nested, grandchild].includes(s.id))
      .map((s) => s.id)
    group(destination)
      ?.querySelector('[data-session=s6] .ss-row')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 200 }))
    await until('父会话菜单标已读', () => !!document.querySelector('[data-action="markRead"]'))
    document.querySelector<HTMLButtonElement>('[data-action="markRead"]')?.click()
    await until(
      '菜单清整棵树',
      () => !sessions.get(nested)?.unread && !sessions.get(grandchild)?.unread,
    )
    if (otherUnread.some((id) => !sessions.get(id)?.unread)) throw new Error('清子树误清兄弟未读')
    if (
      document
        .querySelector('.ss-row.sel')
        ?.closest('[data-session]')
        ?.getAttribute('data-session') !== selectionBefore
    )
      throw new Error('标已读不应打开会话')
    const deviceHead = document.querySelector('.dev-group[data-device=local] .dev-row')
    deviceHead?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 150 }),
    )
    await until('设备菜单全部已读', () => !!document.querySelector('[data-action="markRead"]'))
    document.querySelector<HTMLButtonElement>('[data-action="markRead"]')?.click()
    await until('设备全部清零', () => [...sessions.values()].every((s) => !s.unread))
    return {
      menuClearsDescendants: true,
      deviceMenuClearsAll: true,
      crossProject: true,
      visibleOnExpand: true,
      parentDoesNotClear: true,
      clickClears: true,
      hiddenWindow: true,
    }
  } finally {
    port.postMessage({ t: 'unsub', id: 1 })
    port.close()
  }
}
