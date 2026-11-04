// SDK 0.1.23 的 stdio 引导协议。后续 WebSocket 使用 protobuf JSON；这里仅实现两个引导消息。
// 字段号依据 Apache-2.0 发布的 google/antigravity/proto/localharness.proto。
const MAX_FRAME = 64 * 1024
const varint = (value: number): Buffer => {
  const bytes: number[] = []
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0))
    value = Math.floor(value / 128)
  } while (value)
  return Buffer.from(bytes)
}
const field = (number: number, value: string | Buffer): Buffer => {
  const data = Buffer.from(value)
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data])
}
export function inputConfig(storage: string): Buffer {
  const info = Buffer.concat([
    field(1, 'typescript'),
    field(2, '0.1.23'),
    field(3, process.versions.node),
    field(4, process.platform),
  ])
  const payload = Buffer.concat([field(1, storage), field(3, '127.0.0.1'), field(4, info)])
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}
export function outputConfig(payload: Buffer): { port: number; token: string } {
  let offset = 0
  const read = (): number => {
    let n = 0
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = payload[offset++]
      if (byte === undefined) throw new Error('localharness 引导帧不完整')
      n += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return n
    }
    throw new Error('localharness 引导帧整数无效')
  }
  let port = 0
  let token = ''
  while (offset < payload.length) {
    const key = read()
    if (key === 8) port = read()
    else if (key === 18) {
      const size = read()
      if (offset + size > payload.length) throw new Error('localharness 引导令牌不完整')
      token = payload.subarray(offset, offset + size).toString('utf8')
      offset += size
    } else throw new Error('localharness 引导协议发生变化，请升级 Litch')
  }
  if (port < 1 || port > 65535 || !token || /[\r\n]/.test(token))
    throw new Error('localharness 返回的端口或本地令牌无效')
  return { port, token }
}
export class BootstrapFrame {
  private bytes = Buffer.alloc(0)
  push(chunk: Buffer): Buffer | null {
    this.bytes = Buffer.concat([this.bytes, chunk])
    if (this.bytes.length < 4) return null
    const length = this.bytes.readUInt32LE()
    if (length > MAX_FRAME || length === 0) throw new Error('localharness 引导帧长度无效')
    if (this.bytes.length < length + 4) return null
    return this.bytes.subarray(4, length + 4)
  }
}
