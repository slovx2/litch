// 用户标签保持原归属；租约、快照和调用锁只存在控制端内存中，不依赖设备版本。
import { randomUUID } from 'node:crypto'
import { BadArgs } from './args.mjs'
import type { BrowserHost, BrowserPage, TabOwner } from './model.mjs'
import { sessionKey } from './sites.mjs'

const ownerKey = (owner: TabOwner) => sessionKey(owner.deviceId, owner.threadId)
interface Lease {
  page: BrowserPage
  owner: TabOwner
  turnId: string
  revision: number
}
export function userTabs(host: BrowserHost, invalidate: (id: string) => void) {
  const leases = new Map<string, Lease>()
  const tokens = new Map<
    string,
    { page: BrowserPage; session: string; turnId: string; url: string; at: number }
  >()
  const release = (id: string) => {
    if (!leases.delete(id)) return
    host.release(id)
    invalidate(id)
  }
  const refresh = (id: string) => {
    const lease = leases.get(id)
    if (
      lease &&
      (host.page(id) !== lease.page || (lease.page.inputRevision?.() ?? 0) !== lease.revision)
    )
      release(id)
    return leases.get(id)
  }
  const owns = (page: BrowserPage, owner: TabOwner, turnId: string) => {
    const lease = refresh(page.id)
    return (
      !!lease &&
      lease.page === page &&
      ownerKey(lease.owner) === ownerKey(owner) &&
      lease.turnId === turnId
    )
  }
  return {
    owns,
    controller(page: BrowserPage): TabOwner | undefined {
      return refresh(page.id)?.owner
    },
    token(page: BrowserPage, owner: TabOwner, turnId: string) {
      for (const [key, token] of tokens) if (Date.now() - token.at > 30_000) tokens.delete(key)
      if (tokens.size >= 256) tokens.delete(tokens.keys().next().value ?? '')
      const key = `builtin:${randomUUID()}`
      tokens.set(key, {
        page,
        session: ownerKey(owner),
        turnId,
        url: page.info().url,
        at: Date.now(),
      })
      return key
    },
    take(token: string, owner: TabOwner, turnId: string) {
      const found = tokens.get(token)
      tokens.delete(token)
      if (
        !found ||
        found.session !== ownerKey(owner) ||
        found.turnId !== turnId ||
        Date.now() - found.at > 30_000 ||
        host.page(found.page.id) !== found.page ||
        found.url !== found.page.info().url
      )
        throw new BadArgs('Use a claimToken from a fresh tabs list in this turn.')
      return found.page
    },
    acquire(page: BrowserPage, owner: TabOwner, turnId: string) {
      const existing = refresh(page.id)
      if (existing && !owns(page, owner, turnId))
        throw new BadArgs(
          'This user tab is controlled by another session or turn. Wait for release; do not take over.',
        )
      if (!existing) {
        leases.set(page.id, { page, owner, turnId, revision: page.inputRevision?.() ?? 0 })
        invalidate(page.id)
      }
      page.setAgentActive(true, owner)
    },
    check(page: BrowserPage, owner: TabOwner, turnId: string) {
      if (!owns(page, owner, turnId))
        throw Object.assign(
          new BadArgs(
            'The user tab was released or the user took over. Take a fresh tabs list and claim it again before observing or acting. Do not replay input.',
          ),
          { code: 'staleLease' },
        )
    },
    release(id: string, owner: TabOwner, turnId: string) {
      const existing = refresh(id)
      if (existing && !owns(existing.page, owner, turnId))
        throw new BadArgs('This user tab is controlled by another session or turn.')
      release(id)
    },
    end(owner: TabOwner, turnId: string) {
      for (const [id, lease] of leases)
        if (ownerKey(lease.owner) === ownerKey(owner) && lease.turnId === turnId) release(id)
      for (const [key, token] of tokens)
        if (token.session === ownerKey(owner) && token.turnId === turnId) tokens.delete(key)
    },
  }
}
