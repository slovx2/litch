// 手机上本机整理文件的两份副本：每次写到不是“最新有效”的那一格，另一格留着上一份有效的。
// 写到一半被杀掉，下次启动挑两格里版本号最高的有效那份，不会丢掉整理。
// 只要有一格是更高版本的文件就停用写入（不覆盖）；两格都坏才报坏。纯逻辑，读写由调用方给。
import { type OrganizerLoad, type OrganizerStore, parseOrganizer } from '@litch/core'

export type Slot = 'a' | 'b'

export interface SlotIo {
  /** 读一格的原文；没有是 null */
  read(slot: Slot): string | null
  write(slot: Slot, text: string): void
}

function loadSlot(text: string | null): OrganizerLoad | null {
  if (text === null) return null
  try {
    return parseOrganizer(JSON.parse(text))
  } catch {
    return { kind: 'corrupt' }
  }
}

export function slottedOrganizerStore(io: SlotIo): OrganizerStore {
  /** 最新有效的那一格；下次写另一格 */
  let latest: Slot | null = null
  return {
    load() {
      const loads = { a: loadSlot(io.read('a')), b: loadSlot(io.read('b')) }
      for (const slot of ['a', 'b'] as const) {
        const entry = loads[slot]
        if (entry?.kind === 'newer') return entry
      }
      let best: { slot: Slot; load: Extract<OrganizerLoad, { kind: 'ok' }> } | null = null
      for (const slot of ['a', 'b'] as const) {
        const entry = loads[slot]
        if (entry?.kind !== 'ok') continue
        if (!best || entry.file.revision > best.load.file.revision) best = { slot, load: entry }
      }
      if (best) {
        latest = best.slot
        return best.load
      }
      return loads.a?.kind === 'corrupt' || loads.b?.kind === 'corrupt'
        ? { kind: 'corrupt' }
        : { kind: 'empty' }
    },
    save(file) {
      const slot: Slot = latest === 'a' ? 'b' : 'a'
      io.write(slot, JSON.stringify(file))
      latest = slot
    },
  }
}
