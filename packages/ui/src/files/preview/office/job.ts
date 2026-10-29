import { decodeBase64 } from '@litch/core'
import type { PreviewData } from '../contract.ts'
import { OfficeFailure, ZIP_LIMIT } from './archive.ts'

export function officeJob<T>(
  data: PreviewData,
  format: 'docx' | 'xlsx',
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    if (data.bytes > ZIP_LIMIT || data.dataBase64.length > Math.ceil(ZIP_LIMIT / 3) * 4) {
      reject(new OfficeFailure('budget'))
      return
    }
    const worker =
      format === 'docx'
        ? new Worker(new URL('./zip.worker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./office.worker.ts', import.meta.url), { type: 'module' })
    const finish = (value?: T, error?: unknown) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      worker.terminate()
      if (error) reject(error)
      else resolve(value as T)
    }
    const cancel = () => finish(undefined, new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => finish(undefined, new OfficeFailure('timeout')), 15_000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.onmessage = ({ data: result }) =>
      result.ok ? finish(result.value) : finish(undefined, new OfficeFailure(result.error))
    worker.onerror = () => finish(undefined, new OfficeFailure('invalid'))
    try {
      const bytes = decodeBase64(data.dataBase64)
      worker.postMessage({ bytes: bytes.buffer, format }, [bytes.buffer])
    } catch (error) {
      finish(undefined, error)
    }
  })
}
