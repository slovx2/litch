// 只改 Chrome 自己的分组和工具栏徽标，不改页面标题/favicon，避开导航、站点脚本与缓存的恢复竞态。
import type { ChromeGrant } from '../../automation-contracts/src/litch/chrome-browser.mjs'

interface GroupInfo {
  id: number
  title: string
  color: string
  collapsed: boolean
}
interface SavedTab {
  temporary: boolean
  restoring?: boolean
  tabId: number
  leaseId: string
  session: string
  windowId: number
  index: number
  pinned: boolean
  original: GroupInfo | null
  groupId: number | null
  title: string
}

/** 所有写入串行化；先落恢复记录，再改 Chrome，恢复成功才删记录。失败下次启动/定时重试。 */
export class TabPresentation {
  private tail: Promise<unknown> = Promise.resolve()
  private records = new Map<number, SavedTab>()
  private busy = new Map<number, number>()
  private restoredGroups = new Map<number, number>()
  private chrome: any
  private productName: string
  private prefix: string
  constructor(chrome: any, productName: string, prefix: string) {
    this.productName = productName
    this.prefix = prefix
    this.chrome = chrome
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }
  private save(record: SavedTab): Promise<void> {
    return this.chrome.storage.local.set({ [`${this.prefix}${record.tabId}`]: record })
  }
  async recover(): Promise<void> {
    return this.serial(async () => {
      const saved = await this.chrome.storage.local.get(null)
      for (const [key, record] of Object.entries(saved))
        if (key.startsWith(this.prefix))
          this.records.set((record as SavedTab).tabId, record as SavedTab)
      for (const record of [...this.records.values()])
        await this.restore(record, record.temporary).catch(() => {})
    })
  }
  async claim(grant: ChromeGrant): Promise<void> {
    return this.serial(async () => {
      // 上次恢复失败时先重试，不能让新的租约覆盖恢复凭据。
      const pending = this.records.get(grant.tabId)
      if (pending) await this.restore(pending)
      const tab = await this.chrome.tabs.get(grant.tabId)
      const group = tab.groupId >= 0 ? await this.chrome.tabGroups.get(tab.groupId) : null
      const session = JSON.stringify([grant.owner.deviceId, grant.owner.threadId])
      const short = [...(grant.sessionTitle?.trim() || grant.owner.threadId)].slice(0, 24).join('')
      const record: SavedTab = {
        tabId: grant.tabId,
        leaseId: grant.leaseId,
        session,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        original: group
          ? {
              id: group.id,
              title: group.title ?? '',
              color: group.color,
              collapsed: group.collapsed,
            }
          : null,
        groupId: null,
        title: `${this.productName} · ${short}`,
        temporary: !grant.original && !grant.keep,
      }
      await this.save(record)
      this.records.set(record.tabId, record)
      if (tab.pinned) await this.chrome.tabs.update(tab.id, { pinned: false })
      const sibling = [...this.records.values()].find(
        (other) =>
          other !== record &&
          other.session === session &&
          other.windowId === tab.windowId &&
          other.groupId !== null,
      )
      const existing = sibling
        ? await this.chrome.tabGroups.get(sibling.groupId).catch(() => null)
        : null
      record.groupId = await this.chrome.tabs.group({
        tabIds: [tab.id],
        ...(existing ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }),
      })
      await this.save(record)
      await this.paint(record)
    })
  }
  async active(tabId: number, leaseId: string, active: boolean): Promise<void> {
    return this.serial(async () => {
      const record = this.records.get(tabId)
      if (!record || record.leaseId !== leaseId) return
      this.busy.set(tabId, Math.max(0, (this.busy.get(tabId) ?? 0) + (active ? 1 : -1)))
      await this.paint(record)
    })
  }
  private async paint(record: SavedTab): Promise<void> {
    const active = (this.busy.get(record.tabId) ?? 0) > 0
    await this.chrome.action.setBadgeText({ tabId: record.tabId, text: active ? 'AI' : '' })
    await this.chrome.action.setBadgeBackgroundColor({ tabId: record.tabId, color: '#B85A00' })
    await this.chrome.action.setTitle({
      tabId: record.tabId,
      title: active
        ? `${this.productName} — AI operating this tab · Click to stop`
        : `${this.productName} — Stop browser control`,
    })
    if (record.groupId === null) return
    if (!(await this.chrome.tabGroups.get(record.groupId).catch(() => null))) return
    const running = [...this.records.values()].filter(
      (other) => other.groupId === record.groupId && (this.busy.get(other.tabId) ?? 0) > 0,
    )
    const tab =
      running.length === 1 ? await this.chrome.tabs.get(running[0]?.tabId).catch(() => null) : null
    const suffix = tab ? ` · ${[...(tab.title || 'Tab')].slice(0, 18).join('')}` : ''
    await this.chrome.tabGroups.update(record.groupId, {
      title: running.length ? `▶ AI · ${record.title.slice(8)}${suffix}` : record.title,
      color: running.length ? 'orange' : 'blue',
    })
  }
  async release(tabId: number, leaseId: string): Promise<void> {
    return this.serial(async () => {
      const record = this.records.get(tabId)
      if (record?.leaseId === leaseId) await this.restore(record)
    })
  }
  async keep(tabId: number, leaseId: string, keep: boolean): Promise<void> {
    return this.serial(async () => {
      const record = this.records.get(tabId)
      if (!record || record.leaseId !== leaseId) return
      record.temporary = !keep
      await this.save(record)
    })
  }
  /** 只重试没有活租约的记录，迟到清理不能清掉新的租约。 */
  async retry(live: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      for (const record of [...this.records.values()]) {
        if (!live.has(record.leaseId)) await this.restore(record).catch(() => {})
        else await this.paint(record).catch(() => {})
      }
    })
  }
  private async restore(record: SavedTab, close = false): Promise<void> {
    let tab = await this.chrome.tabs.get(record.tabId).catch(() => null)
    if (close && tab && tab.windowId === record.windowId && tab.groupId === record.groupId) {
      await this.chrome.tabs.remove(tab.id)
      tab = null
    }
    if (tab) {
      await this.chrome.action.setBadgeText({ tabId: tab.id, text: '' })
      await this.chrome.action.setTitle({
        tabId: tab.id,
        title: `${this.productName} — Stop browser control`,
      })
      // 用户手动移动过标签时尊重当前窗口和分组；不把用户的新布局再拉回。
      const currentGroup =
        tab.groupId >= 0 ? await this.chrome.tabGroups.get(tab.groupId).catch(() => null) : null
      const partlyRestored =
        record.restoring &&
        (record.original
          ? currentGroup?.title === record.original.title &&
            currentGroup?.color === record.original.color
          : tab.groupId < 0)
      if (
        tab.windowId === record.windowId &&
        (record.groupId === null || tab.groupId === record.groupId || partlyRestored)
      ) {
        record.restoring = true
        await this.save(record)
        if (record.original) {
          const id = partlyRestored
            ? tab.groupId
            : (this.restoredGroups.get(record.original.id) ?? record.original.id)
          const old = await this.chrome.tabGroups.get(id).catch(() => null)
          const groupId = await this.chrome.tabs.group({
            tabIds: [tab.id],
            ...(old ? { groupId: id } : { createProperties: { windowId: record.windowId } }),
          })
          if (!old) {
            const { title, color, collapsed } = record.original
            await this.chrome.tabGroups.update(groupId, { title, color, collapsed })
            this.restoredGroups.set(record.original.id, groupId)
          }
        } else await this.chrome.tabs.ungroup(tab.id)
        if (record.pinned) await this.chrome.tabs.update(tab.id, { pinned: true })
        await this.chrome.tabs.move(tab.id, { index: record.index })
      }
    }
    this.busy.delete(record.tabId)
    const sibling = [...this.records.values()].find(
      (other) => other !== record && other.groupId === record.groupId,
    )
    if (sibling) await this.paint(sibling)
    await this.chrome.storage.local.remove(`${this.prefix}${record.tabId}`)
    this.records.delete(record.tabId)
  }
}
