// 字节和文本之间的几样小工具：base64、UTF-8。
// 终端的输入输出在协议里是 base64 的字节，核心只转运、数字节数，极少需要真的解开；
// 核心的编译配置不带平台的类型（没有 TextEncoder、atob），所以这里自己写，够用就行。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const PAD = 61 // '='

const DECODE = new Int16Array(128).fill(-1)
for (let at = 0; at < ALPHABET.length; at++) DECODE[ALPHABET.charCodeAt(at)] = at

/** base64 文本解出来是多少字节。不解码，只看长度和末尾的填充 */
export function base64Bytes(text: string): number {
  const length = text.length
  if (length === 0) return 0
  let pad = 0
  if (text.charCodeAt(length - 1) === PAD) pad++
  if (length > 1 && text.charCodeAt(length - 2) === PAD) pad++
  return Math.floor(((length - pad) * 3) / 4)
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  const whole = bytes.length - (bytes.length % 3)
  for (let at = 0; at < whole; at += 3) {
    const n = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)
    out +=
      ALPHABET.charAt(n >> 18) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63)
  }
  const rest = bytes.length - whole
  if (rest === 1) {
    const n = (bytes[whole] ?? 0) << 16
    out += `${ALPHABET.charAt(n >> 18)}${ALPHABET.charAt((n >> 12) & 63)}==`
  } else if (rest === 2) {
    const n = ((bytes[whole] ?? 0) << 16) | ((bytes[whole + 1] ?? 0) << 8)
    out += `${ALPHABET.charAt(n >> 18)}${ALPHABET.charAt((n >> 12) & 63)}${ALPHABET.charAt((n >> 6) & 63)}=`
  }
  return out
}

/** 解不开的字符直接跳过：对面给的东西不该让核心抛错 */
export function decodeBase64(text: string): Uint8Array {
  const out = new Uint8Array(base64Bytes(text))
  let at = 0
  let bits = 0
  let have = 0
  for (let index = 0; index < text.length && at < out.length; index++) {
    const code = text.charCodeAt(index)
    const value = code < 128 ? (DECODE[code] ?? -1) : -1
    if (value < 0) continue
    bits = (bits << 6) | value
    have += 6
    if (have >= 8) {
      have -= 8
      out[at++] = (bits >> have) & 0xff
    }
  }
  return at === out.length ? out : out.subarray(0, at)
}

export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0xfffd
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) {
      // 落单的代理项不是合法的字符，换成替换符
      const safe = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code
      out.push(0xe0 | (safe >> 12), 0x80 | ((safe >> 6) & 63), 0x80 | (safe & 63))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
    }
  }
  return Uint8Array.from(out)
}

/**
 * 一次解完的 UTF-8：不合法的地方换成替换符。要跨块接着解的不要用它。
 * tally 给了的话，换了几处记在它的 replaced 上（读文件时用它知道内容是不是有损）
 */
export function decodeUtf8(bytes: Uint8Array, tally?: { replaced: number }): string {
  let out = ''
  for (let at = 0; at < bytes.length; ) {
    const lead = bytes[at] ?? 0
    const extra = lead < 0x80 ? 0 : lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : -1
    // 开头的字节不合法，或者后面该跟的字节不够了
    if (extra < 0 || at + extra > bytes.length - 1) {
      out += '�'
      if (tally) tally.replaced++
      at++
      continue
    }
    let code = extra === 0 ? lead : lead & (0xff >> (extra + 2))
    let ok = true
    for (let step = 1; step <= extra; step++) {
      const next = bytes[at + step] ?? 0
      if ((next & 0xc0) !== 0x80) {
        ok = false
        break
      }
      code = (code << 6) | (next & 63)
    }
    if (!ok) {
      out += '�'
      if (tally) tally.replaced++
      at++
      continue
    }
    out += String.fromCodePoint(code > 0x10ffff ? 0xfffd : code)
    at += extra + 1
  }
  return out
}

/** 文本直接变成 base64 的 UTF-8 字节 */
export const textToBase64 = (text: string): string => encodeBase64(encodeUtf8(text))

/** 把一块 base64 的开头去掉若干字节。要真的解开再编回去，只在两块输出有重叠时才用得到 */
export function dropBase64Head(text: string, skipBytes: number): string {
  if (skipBytes <= 0) return text
  return encodeBase64(decodeBase64(text).subarray(skipBytes))
}
