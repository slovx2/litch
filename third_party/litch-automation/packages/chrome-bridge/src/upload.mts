import type { BrowserPage } from '../../browser/src/browser/model.mjs'
import { uploadBufferedFiles } from '../../browser/src/browser/upload-files.mjs'

export const CHROME_UPLOAD_MAX_BYTES = 512 * 1024 * 1024
export const UPLOAD_CHUNK_BYTES = 192 * 1024

export function uploadChromeFiles(
  page: BrowserPage,
  node: number,
  paths: string[],
  mode: 'input' | 'drop',
  signal?: AbortSignal,
): Promise<void> {
  return uploadBufferedFiles(
    page,
    node,
    paths,
    mode,
    { fileBytes: CHROME_UPLOAD_MAX_BYTES, totalBytes: CHROME_UPLOAD_MAX_BYTES },
    signal,
  )
}
