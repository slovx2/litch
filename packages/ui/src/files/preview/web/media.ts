export interface MediaType {
  kind: 'audio' | 'video'
  mime: string
}
/** 扩展名与容器头同时匹配；实际 codec 能否播放由本机解码器继续核验。 */
export function mediaType(path: string, bytes: Uint8Array): MediaType | null {
  const ext = path.split('.').at(-1)?.toLowerCase()
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (ext === 'wav' && bytes.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')
    return { kind: 'audio', mime: 'audio/wav' }
  if (
    ext === 'mp3' &&
    bytes.length > 10 &&
    (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2))
  )
    return { kind: 'audio', mime: 'audio/mpeg' }
  if (ext === 'mp4' && bytes.length >= 24 && ascii(4, 8) === 'ftyp')
    return { kind: 'video', mime: 'video/mp4' }
  if (
    ext === 'webm' &&
    bytes.length >= 16 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return { kind: 'video', mime: 'video/webm' }
  return null
}
