// Chrome Web Store V2；认证只在内存中，错误不包含请求头、响应体或底层异常。
import { sign } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { itemId } from './chrome-store-package.mjs'

const origin = 'https://chromewebstore.googleapis.com'
const tokenUrl = 'https://oauth2.googleapis.com/token'
export class StoreError extends Error {}

async function jsonRequest(fetcher, url, options, phase) {
  let response
  try {
    response = await fetcher(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new StoreError(`${phase}网络失败或超时；写请求未自动重试，请核对商店状态。`)
  }
  if (!response.ok)
    throw new StoreError(`${phase}失败（HTTP ${response.status}）；请核对商店后台。`)
  try {
    return await response.json()
  } catch {
    throw new StoreError(`${phase}返回无效 JSON。`)
  }
}

export async function serviceAccountToken(credentials, fetcher = fetch, now = Date.now()) {
  let assertion
  try {
    const key = JSON.parse(credentials)
    if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new Error()
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const iat = Math.floor(now / 1000)
    const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    })}`
    assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), key.private_key).toString('base64url')}`
  } catch {
    throw new StoreError('服务账号 JSON 或私钥格式无效；请在 GitHub Secrets 中更新。')
  }
  const data = await jsonRequest(
    fetcher,
    tokenUrl,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    },
    '获取访问令牌',
  )
  if (typeof data.access_token !== 'string' || !data.access_token)
    throw new StoreError('认证响应缺少访问令牌。')
  return data.access_token
}

export function storeClient(publisher, token, fetcher = fetch, sleep = setTimeout) {
  if (!/^[a-zA-Z0-9_-]+$/.test(publisher)) throw new StoreError('Publisher ID 格式无效。')
  const name = `publishers/${publisher}/items/${itemId}`
  const request = (path, options, phase) =>
    jsonRequest(
      fetcher,
      `${origin}${path}`,
      {
        ...options,
        headers: { ...options?.headers, Authorization: `Bearer ${token}` },
      },
      phase,
    )
  const status = () => request(`/v2/${name}:fetchStatus`, { method: 'GET' }, '查询商店状态')
  return {
    status,
    async upload(bytes, version) {
      const result = await request(
        `/upload/v2/${name}:upload`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: bytes,
        },
        '上传扩展',
      )
      let state = result.uploadState
      if (state === 'SUCCEEDED' && result.crxVersion !== version)
        throw new StoreError('商店返回的上传版本不符，未送审。')
      // 官方枚举是 IN_PROGRESS（文档个别段落写作 UPLOAD_IN_PROGRESS，以枚举为准）。
      for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 20; attempt++) {
        await sleep(3000)
        state = (await status()).lastAsyncUploadState
      }
      if (state !== 'SUCCEEDED') throw new StoreError('上传未确认成功，未送审；请核对商店后台。')
    },
    async publish() {
      const result = await request(
        `/v2/${name}:publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publishType: 'DEFAULT_PUBLISH',
            skipReview: false,
            blockOnWarnings: true,
          }),
        },
        '提交审核',
      )
      if (!['PENDING_REVIEW', 'PUBLISHED'].includes(result.state))
        throw new StoreError('商店未确认送审或公开，请核对后台；未自动重试。')
      return result.state
    },
  }
}
