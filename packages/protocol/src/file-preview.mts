// 文件预览只增加 fs/readFile 的命名空间参数，不改变标准响应。
export interface FilePreviewOption {
  root: string
  maxBytes: number
}

export const PREVIEW_HARD_BYTES = 20 * 1024 * 1024
export const PREVIEW_LIMIT = {
  markdown: 512 * 1024,
  source: 2 * 1024 * 1024,
  image: 8 * 1024 * 1024,
  svg: 1024 * 1024,
  pdf: PREVIEW_HARD_BYTES,
  docx: 10 * 1024 * 1024,
  xlsx: 10 * 1024 * 1024,
  csv: 2 * 1024 * 1024,
  html: 1024 * 1024,
  media: 16 * 1024 * 1024,
} as const
export type PreviewKind = keyof typeof PREVIEW_LIMIT

export type PreviewFailure = 'tooLarge' | 'outside' | 'notFile' | 'changed' | 'busy'
export interface PreviewErrorData {
  litchPreview: { kind: PreviewFailure; bytes?: number; limit?: number }
}
