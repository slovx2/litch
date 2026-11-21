import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Agent as HttpAgent, get as httpGet, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, get as httpsGet } from 'node:https'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { GithubWriteFault } from './write-api.mjs'

export const MANAGED_GITHUB_CLI_VERSION = '2.102.0'
const release = `https://github.com/cli/cli/releases/download/v${MANAGED_GITHUB_CLI_VERSION}/`
// 来自固定版本的官方 gh_2.102.0_checksums.txt；设备不会从网络更新这份信任清单。
const assets = {
  'darwin-x64': [
    'macOS_amd64.zip',
    'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3',
  ],
  'darwin-arm64': [
    'macOS_arm64.zip',
    'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e',
  ],
  'linux-x64': [
    'linux_amd64.tar.gz',
    'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386',
  ],
  'linux-arm64': [
    'linux_arm64.tar.gz',
    '7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484',
  ],
  'win32-x64': [
    'windows_amd64.zip',
    'ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4',
  ],
  'win32-arm64': [
    'windows_arm64.zip',
    '5dcf12aa8525eabd0c46ec414f323ab6cf65229fc2cd46543cc705001bbaf223',
  ],
} as const

export function githubCliAsset(
  platform: NodeJS.Platform,
  arch: string,
): { url: URL; filename: string; sha256: string } {
  const key = `${platform}-${arch}`
  if (!Object.hasOwn(assets, key)) throw new GithubWriteFault('github_gh_platform_unsupported')
  const [suffix, sha256] = assets[key as keyof typeof assets]
  const filename = `gh_${MANAGED_GITHUB_CLI_VERSION}_${suffix}`
  return { url: new URL(filename, release), filename, sha256 }
}

const maxBytes = 64 * 1024 * 1024
const attempts = 3
const attemptTimeoutMs = 25_000
const statusRetry = new Set([408, 429, 500, 502, 503, 504])

/** 生产地址固定为 HTTPS；回环 HTTP 地址只由进程内测试传入。代理不接触任何 GitHub 令牌。 */
export async function downloadGithubCli(
  asset: { url: URL; sha256: string },
  path: string,
  signal: AbortSignal,
  proxyEnv: NodeJS.ProcessEnv = process.env,
  backoffMs = 500,
): Promise<void> {
  const http = new HttpAgent({ proxyEnv })
  const https = new HttpsAgent({ proxyEnv })
  const loopback = asset.url.protocol === 'http:' && asset.url.hostname === '127.0.0.1'
  const allowed = (url: URL) =>
    !url.username &&
    !url.password &&
    (loopback
      ? url.protocol === 'http:' && url.hostname === '127.0.0.1'
      : url.protocol === 'https:' &&
        !url.port &&
        [
          'github.com',
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
        ].includes(url.hostname))
  async function response(
    url: URL,
    requestSignal: AbortSignal,
    redirects = 0,
  ): Promise<IncomingMessage> {
    if (!allowed(url) || redirects > 4) throw new GithubWriteFault('github_gh_download_redirect')
    const secure = url.protocol === 'https:'
    const reply = await new Promise<IncomingMessage>((resolve, reject) => {
      ;(secure ? httpsGet : httpGet)(
        url,
        { agent: secure ? https : http, signal: requestSignal },
        resolve,
      ).once('error', reject)
    })
    const status = reply.statusCode ?? 0
    if (status === 200) return reply
    reply.destroy()
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (!reply.headers.location) throw new GithubWriteFault('github_gh_download_redirect')
      return response(new URL(reply.headers.location, url), requestSignal, redirects + 1)
    }
    if (statusRetry.has(status)) throw new Error('transient download HTTP status')
    throw new GithubWriteFault('github_gh_download_http')
  }

  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted()
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)])
      try {
        const reply = await response(asset.url, requestSignal)
        if (Number(reply.headers['content-length']) > maxBytes) {
          reply.destroy()
          throw new GithubWriteFault('github_gh_download_size')
        }
        const hash = createHash('sha256')
        let size = 0
        await pipeline(
          reply,
          async function* (source) {
            for await (const chunk of source) {
              size += chunk.length
              if (size > maxBytes) throw new GithubWriteFault('github_gh_download_size')
              hash.update(chunk)
              yield chunk
            }
          },
          createWriteStream(path, { mode: 0o600, flags: 'wx' }),
          { signal: requestSignal },
        )
        if (hash.digest('hex') !== asset.sha256)
          throw new GithubWriteFault('github_gh_download_checksum')
        return
      } catch (error) {
        await rm(path, { force: true })
        signal.throwIfAborted()
        if (error instanceof GithubWriteFault) throw error
        if (
          ['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw new GithubWriteFault('github_gh_install_failed')
        if (attempt === attempts - 1) throw new GithubWriteFault('github_gh_download_unavailable')
        await delay(backoffMs * 2 ** attempt, undefined, { signal })
      }
    }
  } finally {
    http.destroy()
    https.destroy()
  }
}
