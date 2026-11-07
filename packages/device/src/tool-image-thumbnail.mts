import { parentPort, workerData } from 'node:worker_threads'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import type { ToolImage } from '../../protocol/src/tool-images.mjs'

/** 只解析格式头；完整图片解码始终在独立 worker 中，不能阻塞协议路由。 */
export function imageInfo(bytes: Buffer): Pick<ToolImage, 'mime' | 'width' | 'height'> | null {
  if (bytes.length < 24) return null
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
    let headers = 0
    for (let at = 8; at + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(at),
        kind = bytes.toString('ascii', at + 4, at + 8)
      if (length > bytes.length - at - 12 || kind === 'acTL') return null
      if (kind === 'IHDR' && ++headers > 1) return null
      at += length + 12
      if (kind === 'IEND')
        return length === 0 && at === bytes.length
          ? { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
          : null
    }
    return null
  }
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)))
    return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at++] !== 255) return null
      while (bytes[at] === 255) at++
      const marker = bytes[at++]!
      if (marker === 218 || marker === 217) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      const size = bytes.readUInt16BE(at)
      if (size < 2 || at + size > bytes.length) return null
      if ([192, 193, 194].includes(marker))
        return {
          mime: 'image/jpeg',
          width: bytes.readUInt16BE(at + 5),
          height: bytes.readUInt16BE(at + 3),
        }
      at += size
    }
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X' && bytes.length >= 30)
      return {
        mime: 'image/webp',
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes.toString('hex', 23, 26) === '9d012a')
      return {
        mime: 'image/webp',
        width: bytes.readUInt16LE(26) & 16383,
        height: bytes.readUInt16LE(28) & 16383,
      }
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21)
      return { mime: 'image/webp', width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 }
    }
  }
  return null
}

export function thumbnail(bytes: Buffer): Omit<ToolImage, 'id' | 'tool'> | null {
  const info = imageInfo(bytes)
  if (
    !info ||
    info.width < 1 ||
    info.height < 1 ||
    info.width > 16384 ||
    info.height > 16384 ||
    info.width * info.height > 20_000_000
  )
    return null
  const base = { ...info, bytes: bytes.length, thumbnail: null }
  // 暂不为 GIF/WebP 解码；保留占位和按需原图，避免引入平台原生依赖。
  if (!['image/png', 'image/jpeg'].includes(info.mime)) return base
  const decoded =
    info.mime === 'image/png'
      ? PNG.sync.read(bytes)
      : jpeg.decode(bytes, { maxResolutionInMP: 20, maxMemoryUsageInMB: 128 })
  const ratio = Math.min(1, 160 / Math.max(decoded.width, decoded.height))
  const width = Math.max(1, Math.round(decoded.width * ratio))
  const height = Math.max(1, Math.round(decoded.height * ratio))
  const small = new PNG({ width, height })
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from =
        (Math.min(decoded.height - 1, Math.floor(y / ratio)) * decoded.width +
          Math.min(decoded.width - 1, Math.floor(x / ratio))) *
        4
      small.data.set(decoded.data.subarray(from, from + 4), (y * width + x) * 4)
    }
  const dataBase64 = PNG.sync.write(small).toString('base64')
  return {
    ...base,
    thumbnail:
      dataBase64.length <= 96 * 1024 ? { mime: 'image/png', dataBase64, width, height } : null,
  }
}

if (parentPort) {
  try {
    parentPort.postMessage(thumbnail(Buffer.from(workerData)))
  } catch {
    parentPort.postMessage(null)
  }
}
