import { type AttachmentOwner, ownerKey } from './attachment-retention-store.mjs'
import { type PowerHarness, probePower } from './power-probe.mjs'

/** 启动或每日清理只查内存中的已加载会话；查询失败时不能把未知当空闲。 */
export async function protectedAttachmentOwners(
  owners: AttachmentOwner[],
  sources: PowerHarness[],
  version: string,
): Promise<Set<string>> {
  const protectedKeys = new Set<string>()
  const harnesses = [...new Set(owners.map((o) => o.harness))]
  await Promise.all(
    harnesses.map(async (harness) => {
      const group = owners.filter((o) => o.harness === harness)
      const source = sources.find((s) => s.id === harness)
      if (!source) {
        for (const o of group) protectedKeys.add(ownerKey(o))
        return
      }
      if (!source.running) return
      try {
        const result = await probePower(source, {
          signal: new AbortController().signal,
          timeoutMs: 5000,
          version,
          mode: 'recover',
        })
        for (const o of group) {
          if (
            !result.complete ||
            result.unread.has(o.threadId) ||
            result.active.has(o.threadId) ||
            result.background.get(o.threadId) === true ||
            result.background.get(o.threadId) === null
          )
            protectedKeys.add(ownerKey(o))
        }
      } catch {
        for (const o of group) protectedKeys.add(ownerKey(o))
      }
    }),
  )
  return protectedKeys
}
