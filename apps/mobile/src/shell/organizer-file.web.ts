// 网页预览里的 organizer-file.ts：只放在内存里（expo-file-system 在网页上没有），每次打开预览都从头来。
import {
  type LocalGroup,
  ORGANIZER_VERSION,
  type OrganizerFile,
  type OrganizerStore,
} from '@litch/core'
import { slottedOrganizerStore } from './organizer-slots'

const files = new Map<string, string>()

/** 隔离预览验收只读检查原文，确认打开首页没有重写隐藏的分组。 */
export const previewOrganizerFiles = (mode: string): (string | null)[] =>
  ['a', 'b'].map((slot) => files.get(`${mode}:${slot}`) ?? null)

/** 预览场景开头放一份本机分组（在 App 读文件之前），好看到组和各种成员状态 */
export function seedOrganizer(mode: string, groups: readonly LocalGroup[]): void {
  const file: OrganizerFile = {
    version: ORGANIZER_VERSION,
    revision: 1,
    groups: [...groups],
    pinOrder: [],
    folds: {},
  }
  files.set(`${mode}:a`, JSON.stringify(file))
}

export function organizerStore(mode: string): OrganizerStore {
  return slottedOrganizerStore({
    read: (slot) => files.get(`${mode}:${slot}`) ?? null,
    write(slot, text) {
      files.set(`${mode}:${slot}`, text)
    },
  })
}
