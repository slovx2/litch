// 解码前先读格式头和尺寸；不信扩展名，不把压缩字节限额当像素限额。
export interface ImageInfo {
  mime: string
  width: number
  height: number
}
export const imageDimensions = (mime: string, width: number, height: number): ImageInfo | null =>
  width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 20_000_000
    ? { mime, width, height }
    : null

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (at: number, count: number) => String.fromCharCode(...bytes.subarray(at, at + count))
  try {
    if (word(0, 8) === '\x89PNG\r\n\x1a\n') {
      if (word(12, 4) !== 'IHDR' || v.getUint32(8) !== 13) return null
      const size = imageDimensions('image/png', v.getUint32(16), v.getUint32(20))
      let at = 8,
        ended = false
      while (at + 12 <= bytes.length) {
        const length = v.getUint32(at),
          type = word(at + 4, 4)
        if (at + 12 + length > bytes.length || type === 'acTL') return null
        at += 12 + length
        if (type === 'IEND') {
          ended = true
          break
        }
      }
      return ended ? size : null
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let at = 2
      while (at + 4 <= bytes.length) {
        if (bytes[at++] !== 0xff) return null
        while (bytes[at] === 0xff) at++
        const marker = v.getUint8(at++)
        if (marker === 0xda || marker === 0xd9) return null
        const length = v.getUint16(at)
        if (length < 2 || at + length > bytes.length) return null
        if ([0xc0, 0xc1, 0xc2].includes(marker))
          return imageDimensions('image/jpeg', v.getUint16(at + 5), v.getUint16(at + 3))
        at += length
      }
    }
    if (word(0, 6) === 'GIF87a' || word(0, 6) === 'GIF89a') {
      const size = imageDimensions('image/gif', v.getUint16(6, true), v.getUint16(8, true))
      let at = 13 + (v.getUint8(10) & 128 ? 3 * 2 ** ((v.getUint8(10) & 7) + 1) : 0),
        images = 0
      const skip = () => {
        while (at < bytes.length) {
          const n = v.getUint8(at++)
          if (!n) return true
          at += n
        }
        return false
      }
      while (at < bytes.length) {
        const block = bytes[at++]
        if (block === 0x3b) return images === 1 ? size : null
        if (block === 0x21) {
          at++
          if (!skip()) return null
        } else if (block === 0x2c) {
          if (++images > 1 || at + 9 > bytes.length) return null
          // 图像子帧也可能比 logical screen 大。
          if (!imageDimensions('image/gif', v.getUint16(at + 4, true), v.getUint16(at + 6, true)))
            return null
          const flags = v.getUint8(at + 8)
          at += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0)
          at++
          if (!skip()) return null
        } else return null
      }
    }
    if (word(0, 4) === 'RIFF' && word(8, 4) === 'WEBP') {
      let at = 12,
        size: ImageInfo | null = null
      const end = v.getUint32(4, true) + 8
      if (end > bytes.length) return null
      while (at + 8 <= end) {
        const type = word(at, 4),
          n = v.getUint32(at + 4, true),
          start = at + 8
        if (start + n > end || type === 'ANIM' || type === 'ANMF') return null
        if (type === 'VP8X') {
          if (n < 10 || v.getUint8(start) & 2) return null
          const u24 = (i: number) =>
            v.getUint8(i) | (v.getUint8(i + 1) << 8) | (v.getUint8(i + 2) << 16)
          size = imageDimensions('image/webp', u24(start + 4) + 1, u24(start + 7) + 1)
          if (!size) return null
        } else if (type === 'VP8 ' && n >= 10 && word(start + 3, 3) === '\x9d\x01\x2a') {
          const frame = imageDimensions(
            'image/webp',
            v.getUint16(start + 6, true) & 0x3fff,
            v.getUint16(start + 8, true) & 0x3fff,
          )
          if (!frame || (size && (frame.width > size.width || frame.height > size.height)))
            return null
          size ??= frame
        } else if (type === 'VP8L' && n >= 5 && bytes[start] === 0x2f) {
          const packed = v.getUint32(start + 1, true)
          const frame = imageDimensions(
            'image/webp',
            (packed & 0x3fff) + 1,
            ((packed >>> 14) & 0x3fff) + 1,
          )
          if (!frame || (size && (frame.width > size.width || frame.height > size.height)))
            return null
          size ??= frame
        }
        at = start + n + (n & 1)
      }
      return size
    }
  } catch {
    return null
  }
  return null
}
