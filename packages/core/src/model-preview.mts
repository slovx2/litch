import type { PreviewKind } from '../../protocol/src/file-preview.mjs'

export type { PreviewKind } from '../../protocol/src/file-preview.mjs'
export { PREVIEW_LIMIT } from '../../protocol/src/file-preview.mjs'

/** 二进制只在一次命令应答里传递，不进会话副本或手机的 FileContent。 */
export type FilePreview =
  | { kind: 'ready'; path: string; format: PreviewKind; dataBase64: string; bytes: number }
  | { kind: 'tooLarge'; path: string; bytes: number; limit: number }
  | {
      kind: 'unsupported' | 'missing' | 'outside' | 'notFile' | 'changed' | 'busy' | 'invalid'
      path: string
    }

/** 只识别格式；是否已注册 renderer 由界面决定。 */
export function previewKind(path: string): PreviewKind | null {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'svg') return 'svg'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext ?? '')) return 'image'
  if (ext === 'pdf' || ext === 'docx' || ext === 'xlsx') return ext
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (['mp3', 'wav', 'mp4', 'webm'].includes(ext ?? '')) return 'media'
  return null
}
