// 在任何 Office 库接触 ZIP 前核对目录，并逐项流式展开。绝不让库先做无界解压。
import { scanXml } from './xml.ts'
export const ZIP_LIMIT = 10 * 1024 * 1024
export const EXPANDED_LIMIT = 40 * 1024 * 1024
export type OfficeError = 'invalid' | 'budget' | 'active' | 'timeout'
export class OfficeFailure extends Error {
  readonly kind: OfficeError
  constructor(kind: OfficeError) {
    super(kind)
    this.kind = kind
  }
}
export interface Part {
  name: string
  bytes: Uint8Array<ArrayBuffer>
}
interface Entry {
  name: string
  start: number
  packed: number
  size: number
  crc: number
  method: number
}
const fail = (kind: OfficeError = 'invalid'): never => {
  throw new OfficeFailure(kind)
}
const decoder = new TextDecoder('utf-8', { fatal: true })

export function directory(bytes: Uint8Array): Entry[] {
  if (bytes.length > ZIP_LIMIT) fail('budget')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (i: number) => v.getUint16(i, true)
  const u32 = (i: number) => v.getUint32(i, true)
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--
  if (end < 0 || end + 22 + u16(end + 20) !== bytes.length) fail()
  const count = u16(end + 10),
    offset = u32(end + 16),
    length = u32(end + 12)
  if (u16(end + 4) || u16(end + 6) || count !== u16(end + 8) || !count || count === 65535) fail()
  if (count > 2048) fail('budget')
  if (offset + length !== end) fail()
  const entries: Entry[] = [],
    names = new Set<string>(),
    ranges: [number, number][] = []
  let at = offset,
    total = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) fail()
    const flags = u16(at + 8),
      method = u16(at + 10),
      packed = u32(at + 20),
      size = u32(at + 24)
    const n = u16(at + 28),
      extra = u16(at + 30),
      comment = u16(at + 32),
      local = u32(at + 42)
    if (flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || u16(at + 34)) fail()
    if (at + 46 + n + extra + comment > end || local + 30 > offset) fail()
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + n))
    if (
      !name ||
      name.length > 512 ||
      /[\\\x00-\x1f:#?%]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((p) => p === '.' || p === '..') ||
      names.has(name)
    )
      fail()
    names.add(name)
    if ((total += size) > EXPANDED_LIMIT) fail('budget')
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) fail()
    const localName = u16(local + 26),
      start = local + 30 + localName + u16(local + 28)
    if (
      start + packed > offset ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + localName)) !== name
    )
      fail()
    ranges.push([local, start + packed])
    entries.push({ name, start, packed, size, crc: u32(at + 16), method })
    at += 46 + n + extra + comment
  }
  if (at !== end) fail()
  ranges.sort((a, b) => a[0] - b[0])
  let previousEnd = 0
  for (const [start, end] of ranges) {
    if (start < previousEnd) fail()
    previousEnd = end
  }
  return entries
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1
  return i >>> 0
})
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] as number)
  return (crc ^ 0xffffffff) >>> 0
}
export async function unpack(input: Uint8Array<ArrayBuffer>): Promise<Part[]> {
  const entries = directory(input),
    parts: Part[] = []
  let total = 0,
    tags = 0
  for (const entry of entries) {
    const compressed = input.slice(entry.start, entry.start + entry.packed)
    const chunks: Uint8Array[] = []
    let size = 0
    const take = (chunk: Uint8Array) => {
      size += chunk.length
      total += chunk.length
      if (total > EXPANDED_LIMIT) fail('budget')
      // 实际长度超过声明也立即停，不能先累积完再比较。
      if (size > entry.size) fail()
      chunks.push(chunk)
    }
    if (entry.method === 0) take(compressed)
    else {
      // 每次最多喂 1 KiB 压缩输入，避免解码器在 JS 下一次计数前展开整个大块。
      // DEFLATE 单块的极端展开也因此有界；readable 的背压阻止继续喂入。
      let cursor = 0
      const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (cursor >= compressed.length) {
            controller.close()
            return
          }
          controller.enqueue(compressed.subarray(cursor, cursor + 1024))
          cursor += 1024
        },
      })
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          take(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    }
    if (size !== entry.size) fail()
    const bytes = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.length
    }
    if (crc32(bytes) !== entry.crc) fail()
    if (/vba|activex|embeddings|macrosheets/i.test(entry.name)) fail('active')
    if (/\.(xml|rels)$/i.test(entry.name)) {
      const xml = decoder.decode(bytes)
      if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|macroEnabled/i.test(xml)) fail('active')
      tags += scanXml(xml)
      if (tags > 500_000) fail('budget')
    }
    if (!entry.name.endsWith('/')) parts.push({ name: entry.name, bytes })
  }
  return parts
}
export function errorKind(error: unknown): OfficeError {
  return error instanceof OfficeFailure ? error.kind : 'invalid'
}
