// 草稿文件的订阅钩子（draft-files.ts 是纯逻辑，单测里不能带 React）。
import { useSyncExternalStore } from 'react'
import { draftsCleared, draftVersion, subscribeDrafts } from './draft-files'

export const useDraftVersion = () => useSyncExternalStore(subscribeDrafts, draftVersion)
export const useDraftsCleared = () => useSyncExternalStore(subscribeDrafts, draftsCleared)
