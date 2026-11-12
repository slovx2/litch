/** 两端共用的短媒体预算；播放器还须检查实际解码能力、时长和像素。 */
export const SHORT_MEDIA_SECONDS = 300
export const SHORT_MEDIA_PIXELS = 20_000_000
export interface ShortMediaType {
  kind: 'audio' | 'video'
  mime: 'audio/wav' | 'audio/mpeg' | 'video/mp4' | 'video/webm'
}

/** 以内容探测为准。路径仅保留调用接口，扩展名不能改变识别结果。 */
export function shortMediaType(_path: string, bytes: Uint8Array): ShortMediaType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')
    return { kind: 'audio', mime: 'audio/wav' }
  if (
    bytes.length > 10 &&
    (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2))
  )
    return { kind: 'audio', mime: 'audio/mpeg' }
  if (bytes.length >= 24 && ascii(4, 8) === 'ftyp') return { kind: 'video', mime: 'video/mp4' }
  if (
    bytes.length >= 16 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return { kind: 'video', mime: 'video/webm' }
  return null
}
