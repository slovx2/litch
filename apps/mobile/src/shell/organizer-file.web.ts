// 网页预览里的 organizer-file.ts：只放在内存里（expo-file-system 在网页上没有），每次打开预览都从头来。
import type { OrganizerStore } from '@litch/core'
import { slottedOrganizerStore } from './organizer-slots'

const files = new Map<string, string>()

export function organizerStore(mode: string): OrganizerStore {
  return slottedOrganizerStore({
    read: (slot) => files.get(`${mode}:${slot}`) ?? null,
    write(slot, text) {
      files.set(`${mode}:${slot}`, text)
    },
  })
}
