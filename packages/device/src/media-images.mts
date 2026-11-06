import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isAbsolute, parse } from 'node:path'
import {
  IMAGE_BYTES,
  type ImageReadResult,
  imageFormat,
  SVG_BYTES,
} from '../../protocol/src/media-images.mjs'
import { readPreview } from '../../shared/src/file-preview.mjs'

/** 保守的公网白名单：IPv6 只接受全球单播，并排除文档/隧道/转换地址。 */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6) return false
  // WHATWG URL 将 IPv6 正规化，避免 2001:0db8 等拼写绕过保留前缀。
  const ip = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
  return /^[23][0-9a-f]{3}:/.test(ip) && !/^2001:|^2002:|^3fff:/.test(ip)
}

const imageNetwork = { lookup, httpRequest, httpsRequest }
const tooLarge = (bytes: number) =>
  Object.assign(new Error('图片过大'), {
    imageBytes: Number.isSafeInteger(bytes) ? bytes : IMAGE_BYTES + 1,
  })
export async function downloadImage(
  source: string,
  signal: AbortSignal,
  network = imageNetwork,
): Promise<Buffer> {
  let url = new URL(source)
  for (let hop = 0; hop <= 4; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('图片地址无效')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await new Promise<LookupAddress[]>((resolve, reject) => {
          const abort = () => reject(new Error('图片 DNS 查询超时'))
          signal.addEventListener('abort', abort, { once: true })
          network
            .lookup(host, { all: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort))
        })
    signal.throwIfAborted()
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
      throw new Error('图片地址不是公网地址')
    const target = addresses[0]
    if (!target) throw new Error('没有可用图片地址')
    const response = await new Promise<{ bytes?: Buffer; location?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? network.httpsRequest : network.httpRequest)(
        url,
        {
          signal,
          agent: false,
          family: target.family,
          // DNS 只解析一次；保留原 Host/SNI 和证书验证，连接固定到已核验的 IP。
          lookup: (_hostname, _options, done) => done(null, target.address, target.family),
          headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' },
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const location = res.headers.location
            res.destroy()
            if (location) resolve({ location })
            else reject(new Error('跳转无地址'))
            return
          }
          if (
            res.statusCode !== 200 ||
            !/^image\//i.test(res.headers['content-type'] ?? '') ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
          ) {
            res.destroy()
            reject(new Error('响应不是图片'))
            return
          }
          if (Number(res.headers['content-length']) > IMAGE_BYTES) {
            res.destroy()
            reject(tooLarge(Number(res.headers['content-length'])))
            return
          }
          let size = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > IMAGE_BYTES) {
              res.destroy(tooLarge(size))
              return
            }
            chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }))
        },
      )
      request.on('error', reject)
      request.end()
    })
    if (response.bytes) return response.bytes
    if (!response.location) throw new Error('跳转无地址')
    url = new URL(response.location, url)
  }
  throw new Error('图片跳转过多')
}

/** 只由已认证且声明 mediaImages 的界面连接进入；不在模型工具表中登记。 */
export class MediaImages {
  private active = new Map<string, Set<AbortController>>()
  async read(peer: string, source: unknown): Promise<ImageReadResult> {
    if (typeof source !== 'string' || !source || source.length > 8192) return { kind: 'invalid' }
    if ([...this.active.values()].reduce((n, set) => n + set.size, 0) >= 4) return { kind: 'busy' }
    const cancel = new AbortController()
    const set = this.active.get(peer) ?? new Set<AbortController>()
    set.add(cancel)
    this.active.set(peer, set)
    const timer = setTimeout(() => cancel.abort(), 15000)
    try {
      let bytes: Buffer
      if (/^https?:\/\//i.test(source)) bytes = await downloadImage(source, cancel.signal)
      else {
        if (
          !isAbsolute(source) ||
          /^[\\/]{2}/.test(source) ||
          /[\u0000-\u001f\u007f]/.test(source) ||
          source.split(/[\\/]/).includes('..')
        )
          return { kind: 'invalid' }
        const data = await readPreview(
          source,
          { root: parse(source).root, maxBytes: IMAGE_BYTES },
          true,
        )
        bytes = Buffer.from(data.dataBase64, 'base64')
      }
      cancel.signal.throwIfAborted()
      const format = imageFormat(bytes)
      if (!format) return { kind: 'unsupported' }
      const limit = format === 'svg' ? SVG_BYTES : IMAGE_BYTES
      if (bytes.length > limit) return { kind: 'tooLarge', bytes: bytes.length, limit }
      return { kind: 'ready', format, bytes: bytes.length, dataBase64: bytes.toString('base64') }
    } catch (error) {
      const value = error as {
        imageBytes?: number
        code?: string
        data?: { litchPreview?: { kind?: string; bytes?: number; limit?: number } }
      }
      if (value.imageBytes !== undefined)
        return { kind: 'tooLarge', bytes: value.imageBytes, limit: IMAGE_BYTES }
      if (value.code === 'ENOENT' || value.code === 'ENOTDIR') return { kind: 'missing' }
      const reason = value.data?.litchPreview
      if (reason?.kind === 'tooLarge')
        return {
          kind: 'tooLarge',
          bytes: reason.bytes ?? IMAGE_BYTES + 1,
          limit: reason.limit ?? IMAGE_BYTES,
        }
      if (reason?.kind === 'notFile' || reason?.kind === 'changed') return { kind: reason.kind }
      return { kind: 'invalid' }
    } finally {
      clearTimeout(timer)
      set.delete(cancel)
      if (!set.size) this.active.delete(peer)
    }
  }
  close(peer?: string): void {
    for (const [id, set] of this.active) {
      if (peer !== undefined && id !== peer) continue
      for (const cancel of set) cancel.abort()
      this.active.delete(id)
    }
  }
}
