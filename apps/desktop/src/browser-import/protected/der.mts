import { ReadFault } from './result.mjs'

// 只解析 NSS 用到的定长 DER；拒绝不定长、过深、越界、尾随内容。
export interface Der {
  tag: number
  value: Buffer
  encoded: Buffer
  children: Der[]
}
export function parseDer(data: Buffer): Der {
  function read(start: number, limit: number, depth: number): [Der, number] {
    if (depth > 12 || start + 2 > limit) throw new ReadFault('failed')
    const tag = data[start] ?? 0
    let size = data[start + 1] ?? 0
    let offset = start + 2
    if (size & 0x80) {
      const bytes = size & 0x7f
      if (!bytes || bytes > 4 || offset + bytes > limit) throw new ReadFault('failed')
      size = 0
      for (let i = 0; i < bytes; i++) size = size * 256 + (data[offset++] ?? 0)
    }
    const end = offset + size
    if (end > limit) throw new ReadFault('failed')
    const children: Der[] = []
    if (tag === 0x30) {
      let position = offset
      while (position < end) {
        const [child, next] = read(position, end, depth + 1)
        children.push(child)
        position = next
      }
    }
    return [
      { tag, value: data.subarray(offset, end), encoded: data.subarray(start, end), children },
      end,
    ]
  }
  const [node, end] = read(0, data.length, 0)
  if (end !== data.length) throw new ReadFault('failed')
  return node
}
export function child(node: Der, index: number, tag: number): Der {
  const value = node.children[index]
  if (!value || value.tag !== tag) throw new ReadFault('failed')
  return value
}
export function integer(node: Der): number {
  if (node.tag !== 2 || !node.value.length || node.value.length > 4 || (node.value[0] ?? 0) & 0x80)
    throw new ReadFault('failed')
  let value = 0
  for (const byte of node.value) value = value * 256 + byte
  return value
}
export function oid(node: Der): string {
  if (node.tag !== 6) throw new ReadFault('failed')
  return node.value.toString('hex')
}
export const OID = {
  pbes2: '2a864886f70d01050d',
  pbkdf2: '2a864886f70d01050c',
  sha1: '2a864886f70d0207',
  sha256: '2a864886f70d0209',
  sha384: '2a864886f70d020a',
  sha512: '2a864886f70d020b',
  aes256: '60864801650304012a',
  des3: '2a864886f70d0307',
  pbeSha1Des3: '2a864886f70d010c050103',
} as const
