// 测试用的思考块签名：照真签名的结构自己拼（base64 的 protobuf，第 2 字段里的第 1 字段里的第 8 字段是块类型），
// 不放真实签名。前后掺几个无关字段，让解析要跳过它们。
const varint = (value: number): number[] => {
  const out: number[] = []
  let rest = value
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

const bytesField = (number: number, bytes: Uint8Array): Buffer =>
  Buffer.from([...varint(number * 8 + 2), ...varint(bytes.length), ...bytes])

const numberField = (number: number, value: number): Buffer =>
  Buffer.from([...varint(number * 8), ...varint(value)])

/** 块类型是 kind（"narration"、"thinking"……）的签名 */
export function signatureOf(kind: string): string {
  const inner = Buffer.concat([
    numberField(2, 300),
    bytesField(3, Buffer.from('mock')),
    bytesField(8, Buffer.from(kind)),
  ])
  const middle = Buffer.concat([bytesField(1, inner), numberField(4, 1)])
  return Buffer.concat([
    numberField(1, 7),
    bytesField(2, middle),
    bytesField(5, Buffer.alloc(64, 1)),
  ]).toString('base64')
}
