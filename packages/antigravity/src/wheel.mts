import { inflateRawSync } from 'node:zlib'

// 只读指定成员，不展开路径，不执行 wheel 里的 Python 或安装脚本。
export function wheelMember(zip: Buffer, name: string, maxBytes = 192 * 1024 * 1024): Buffer {
  let end = zip.length - 22
  for (; end >= Math.max(0, zip.length - 65557); end--)
    if (zip.readUInt32LE(end) === 0x06054b50) break
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('wheel ZIP 目录损坏')
  const count = zip.readUInt16LE(end + 10)
  let position = zip.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    if (position + 46 > zip.length || zip.readUInt32LE(position) !== 0x02014b50)
      throw new Error('wheel ZIP 成员损坏')
    const flags = zip.readUInt16LE(position + 8)
    const method = zip.readUInt16LE(position + 10)
    const compressed = zip.readUInt32LE(position + 20)
    const size = zip.readUInt32LE(position + 24)
    const nameSize = zip.readUInt16LE(position + 28)
    const extraSize = zip.readUInt16LE(position + 30)
    const commentSize = zip.readUInt16LE(position + 32)
    const local = zip.readUInt32LE(position + 42)
    const member = zip.subarray(position + 46, position + 46 + nameSize).toString()
    position += 46 + nameSize + extraSize + commentSize
    if (member !== name) continue
    if (
      flags & 1 ||
      size > maxBytes ||
      local + 30 > zip.length ||
      zip.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error('wheel 成员加密、过大或已损坏')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    if (start + compressed > zip.length) throw new Error('wheel 成员被截断')
    const data = zip.subarray(start, start + compressed)
    const result =
      method === 0
        ? data
        : method === 8
          ? inflateRawSync(data, { maxOutputLength: maxBytes })
          : null
    if (!result || result.length !== size) throw new Error('wheel 压缩方式或成员大小无效')
    return result
  }
  throw new Error(`官方 wheel 缺少 ${name}`)
}
