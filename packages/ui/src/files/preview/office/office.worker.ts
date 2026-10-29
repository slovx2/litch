import { errorKind, unpack } from './archive.ts'
import { spreadsheet } from './spreadsheet.ts'

// 一个文件一个 Worker；取消、超时或收到结果即终止，不留下跨文件缓存。
self.onmessage = async ({ data }: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const parts = await unpack(new Uint8Array(data.bytes))
    self.postMessage({ ok: true, value: await spreadsheet(parts) })
  } catch (error) {
    self.postMessage({ ok: false, error: errorKind(error) })
  }
}
