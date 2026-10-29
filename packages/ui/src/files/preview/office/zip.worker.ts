import { errorKind, unpack } from './archive.ts'

self.onmessage = async ({ data }: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const parts = await unpack(new Uint8Array(data.bytes))
    self.postMessage(
      { ok: true, value: parts },
      { transfer: parts.map((part) => part.bytes.buffer) },
    )
  } catch (error) {
    self.postMessage({ ok: false, error: errorKind(error) })
  }
}
