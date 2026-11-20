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
}

/** 所有写入串行化；先落恢复记录，再改 Chrome，恢复成功才删记录。失败下次启动/定时重试。 */
export class TabPresentation {
  private tail: Promise<unknown> = Promise.resolve()
  private records = new Map<number, SavedTab>()
  private paintedGroups = new Set<number>()
  private cleared = new WeakSet<SavedTab>()
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
      await this.paintBadge(record.tabId)
      if (record.groupId !== null && !this.paintedGroups.has(record.groupId)) {
        await this.chrome.tabGroups.update(record.groupId, {
          title: `▶ AI · ${this.productName} · ${short}`,
          color: 'orange',
        })
        this.paintedGroups.add(record.groupId)
      }
    })
  }

  /** Chrome 可能在主文档导航时清掉逐标签徽标；实际丢失才重新写。 */
  async navigated(tabId: number, leaseId: string): Promise<void> {
    return this.serial(async () => {
      const record = this.records.get(tabId)
      if (!record || record.leaseId !== leaseId || record.restoring) return
      if ((await this.chrome.action.getBadgeText({ tabId })) !== 'AI') await this.paintBadge(tabId)
    })
  }

  private async paintBadge(tabId: number): Promise<void> {
    await this.chrome.action.setBadgeBackgroundColor({ tabId, color: '#B85A00' })
    await this.chrome.action.setTitle({
      tabId,
      title: `${this.productName} — AI controls this tab · Click to stop`,
    })
    await this.chrome.action.setBadgeText({ tabId, text: 'AI' })
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
      if (!this.cleared.has(record)) {
        // 释放逐标签覆盖，让停止控制的全局 OFF 徽标接管。
        await this.chrome.action.setBadgeText({ tabId: tab.id, text: null })
        await this.chrome.action.setTitle({
          tabId: tab.id,
          title: `${this.productName} — Browser control`,
        })
        this.cleared.add(record)
      }
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
    await this.chrome.storage.local.remove(`${this.prefix}${record.tabId}`)
    this.records.delete(record.tabId)
    if (
      record.groupId !== null &&
      ![...this.records.values()].some((other) => other.groupId === record.groupId)
    )
      this.paintedGroups.delete(record.groupId)
  }
}
