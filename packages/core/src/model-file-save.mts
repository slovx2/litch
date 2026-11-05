import type { Text } from './phrase.mjs'

export type FileRevealResult = 'opened' | 'remote' | 'missing' | 'denied' | 'failed'

/** 桌面外壳另存文件的元数据；文件字节不经过渲染进程或主进程。 */
export interface FileSaveSource {
  deviceId: string
  root: string
  path: string
}
export interface FileSaveRequest extends FileSaveSource {
  id: string
}
export interface FileSaveProgress {
  id: string
  state: 'saving' | 'saved' | 'failed' | 'cancelled'
  bytes: number
  total: number | null
  destination: string
  error?: string
  errorText?: Text
}
