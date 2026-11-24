// 假飞书长连接的帧编解码。飞书长连接的帧是 protobuf（SDK 里叫 pbbp2.Frame），这里只实现假服务端用得到的字段：
//   1 SeqID uint64、2 LogID uint64、3 service int32、4 method int32（0 控制帧、1 数据帧）、
//   5 headers 重复 {1 key string, 2 value string}、6 payloadEncoding、7 payloadType、8 payload bytes、9 LogIDNew。
// 用 SDK 自己的编码器会把测试绑在它没公开的内部结构上，所以单写一份；字段号照 SDK 1.77.0 的生成代码。

export interface FrameHeader {
  key: string
  value: string
}

export interface Frame {
  SeqID: number
  LogID: number
  service: number
  method: number
  headers: FrameHeader[]
  payload?: Uint8Array
}

function varint(value: number, out: number[]): void {
  let rest = BigInt(value)
  do {
    let byte = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest > 0n) byte |= 0x80
    out.push(byte)
  } while (rest > 0n)
}

function tag(field: number, wire: number, out: number[]): void {
  varint((field << 3) | wire, out)
}

function bytesField(field: number, data: Uint8Array, out: number[]): void {
  tag(field, 2, out)
  varint(data.length, out)
  for (const byte of data) out.push(byte)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = []
  tag(1, 0, out)
  varint(frame.SeqID, out)
  tag(2, 0, out)
  varint(frame.LogID, out)
  tag(3, 0, out)
  varint(frame.service, out)
  tag(4, 0, out)
  varint(frame.method, out)
  for (const header of frame.headers) {
    const inner: number[] = []
    bytesField(1, encoder.encode(header.key), inner)
    bytesField(2, encoder.encode(header.value), inner)
    bytesField(5, Uint8Array.from(inner), out)
  }
  if (frame.payload) bytesField(8, frame.payload, out)
  return Uint8Array.from(out)
}

class Reader {
  offset = 0
  readonly data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
  }
  get done(): boolean {
    return this.offset >= this.data.length
  }
  varint(): number {
    let result = 0n
    let shift = 0n
    for (;;) {
      const byte = this.data[this.offset++]
      if (byte === undefined) throw new Error('帧被截断')
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7n
    }
    return Number(result)
  }
  bytes(): Uint8Array {
    const length = this.varint()
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 2) this.bytes()
    else if (wire === 1) this.offset += 8
    else if (wire === 5) this.offset += 4
    else throw new Error(`不认识的线型 ${wire}`)
  }
}

function decodeHeader(data: Uint8Array): FrameHeader {
  const reader = new Reader(data)
  const header: FrameHeader = { key: '', value: '' }
  while (!reader.done) {
    const key = reader.varint()
    const field = key >> 3
    if (field === 1) header.key = decoder.decode(reader.bytes())
    else if (field === 2) header.value = decoder.decode(reader.bytes())
    else reader.skip(key & 7)
  }
  return header
}

export function decodeFrame(data: Uint8Array): Frame {
  const reader = new Reader(data)
  const frame: Frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] }
  while (!reader.done) {
    const key = reader.varint()
    const field = key >> 3
    const wire = key & 7
    if (field === 1) frame.SeqID = reader.varint()
    else if (field === 2) frame.LogID = reader.varint()
    else if (field === 3) frame.service = reader.varint()
    else if (field === 4) frame.method = reader.varint()
    else if (field === 5) frame.headers.push(decodeHeader(reader.bytes()))
    else if (field === 8) frame.payload = reader.bytes()
    else reader.skip(wire)
  }
  return frame
}

export function header(frame: Frame, key: string): string | undefined {
  return frame.headers.find((item) => item.key === key)?.value
}
