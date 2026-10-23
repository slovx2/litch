// Claude 的旁白（narration）：服务端对模型在工具调用之间那段说明文字的摘要，装在 thinking 块里送来，
// 但不是模型的推理。Claude Code 的终端界面和 Claude 桌面端都把它当说明文字画，这里同样：旁白出 agentMessage，
// 其余的 thinking 照旧出 reasoning。认不出就当思考。
//
// 认法有两种：
// - 实时回合里，CLI 给助手消息那一帧带 narration_block_indexes（相对这一帧 message.content 的下标）；
// - 帧上没有这个字段（老一些的 CLI）、读原生记录（jsonl 里没有这个字段）时，解块上的签名：
//   base64 解出来是 protobuf，第 2 字段里的第 1 字段里的第 8 字段是字符串 "narration"。

/** 这一帧助手消息里哪些块标了旁白；帧上没有这个字段时是 null（这时要解签名） */
export function narrationIndexes(frame: Record<string, unknown>): ReadonlySet<number> | null {
  const indexes = frame.narration_block_indexes
  if (!Array.isArray(indexes)) return null
  return new Set(indexes.filter((index): index is number => typeof index === 'number'))
}

/**
 * 这个 thinking 块是不是旁白。要有字才算：标了旁白却没字的照普通思考（空思考本来就不出条目）。
 * indexes 是 narrationIndexes 的结果，读历史时不给
 */
export function isNarration(
  block: Record<string, unknown>,
  index: number,
  indexes: ReadonlySet<number> | null = null,
): boolean {
  if (block.type !== 'thinking' || !String(block.thinking ?? '').trim()) return false
  if (indexes) return indexes.has(index)
  return typeof block.signature === 'string' && signatureKind(block.signature) === 'narration'
}

/** 签名里记的块类型（"narration"、"summary" 之类）；解不出来是 null */
export function signatureKind(signature: string): string | null {
  const outer = lengthField(Buffer.from(signature, 'base64'), 2)
  const middle = outer && lengthField(outer, 1)
  const kind = middle && lengthField(middle, 8)
  if (!kind) return null
  const text = Buffer.from(kind).toString('utf8')
  return /^[\x20-\x7e]+$/.test(text) ? text : null
}

/** protobuf 消息里头一个编号是 field、按长度前缀编码的字段的内容；没有或者格式不对是 null */
function lengthField(bytes: Uint8Array, field: number): Uint8Array | null {
  let at = 0
  const varint = (): number | null => {
    let value = 0
    for (let shift = 0; shift < 35; shift += 7) {
      if (at >= bytes.length) return null
      const byte = bytes[at++] as number
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    return null
  }
  while (at < bytes.length) {
    const key = varint()
    if (key === null) return null
    const number = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      if (varint() === null) return null
    } else if (wire === 1) {
      at += 8
    } else if (wire === 5) {
      at += 4
    } else if (wire === 2) {
      const length = varint()
      if (length === null || at + length > bytes.length) return null
      if (number === field) return bytes.subarray(at, at + length)
      at += length
    } else {
      return null
    }
  }
  return null
}
