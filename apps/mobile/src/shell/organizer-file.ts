// 手机上的本机整理文件：应用文档目录里两格副本（organizer-slots.ts），文件名带装法前缀，正式、模拟、夹具各一份。
import type { OrganizerStore } from '@litch/core'
import { File, Paths } from 'expo-file-system'
import { type Slot, slottedOrganizerStore } from './organizer-slots'

export function organizerStore(mode: string): OrganizerStore {
  const file = (slot: Slot) => new File(Paths.document, `${mode}-sidebar-organizer.${slot}.json`)
  return slottedOrganizerStore({
    read(slot) {
      const target = file(slot)
      return target.exists ? target.textSync() : null
    },
    write(slot, text) {
      const target = file(slot)
      target.create({ overwrite: true })
      target.write(text)
    },
  })
}
