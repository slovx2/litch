import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { serviceAccountToken, storeClient } from './chrome-store-api.mjs'
import { itemId } from './chrome-store-package.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = JSON.stringify({
  type: 'service_account',
  client_email: 'fixture@example.invalid',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://untrusted.invalid',
})
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('服务账号用 RS256 交换限定 scope 的短期令牌，不信任 key 中的 token_uri', async () => {
  let calls = 0
  const token = await serviceAccountToken(
    key,
    async (url, options) => {
      calls++
      assert.equal(url, 'https://oauth2.googleapis.com/token')
      assert.equal(options.method, 'POST')
      assert.equal(options.redirect, 'error')
      assert.equal(options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      const [header, claims, signature] = options.body.get('assertion').split('.')
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
      assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
        iss: 'fixture@example.invalid',
        scope: 'https://www.googleapis.com/auth/chromewebstore',
        aud: url,
        iat: 1000,
        exp: 4600,
      })
      assert.ok(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      )
      return response({ access_token: 'fake-token' })
    },
    1_000_000,
  )
  assert.equal(token, 'fake-token')
  assert.equal(calls, 1)
})

test('认证错误不会把私钥、JWT、服务端响应或底层错误带到日志', async () => {
  await assert.rejects(serviceAccountToken('TOP_SECRET'), (e) => !e.message.includes('TOP_SECRET'))
  await assert.rejects(
    serviceAccountToken(key, async () => response({ error: 'TOP_SECRET' }, 403)),
    /HTTP 403/,
  )
  await assert.rejects(
    serviceAccountToken(key, async () => {
      throw new Error('TOP_SECRET')
    }),
    (e) => !e.message.includes('TOP_SECRET'),
  )
  await assert.rejects(
    serviceAccountToken(key, async () => response({})),
    /缺少访问令牌/,
  )
})

test('真实客户端替身验证 ZIP 上传、异步轮询、DEFAULT_PUBLISH 自动发布请求', async () => {
  const calls = []
  const queue = [
    { uploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'SUCCEEDED' },
    { state: 'PENDING_REVIEW' },
  ]
  const sleeps = []
  const client = storeClient(
    'publisher-fixture',
    'secret-token',
    async (url, options) => {
      calls.push({ url, ...options })
      assert.equal(options.headers.Authorization, 'Bearer secret-token')
      assert.equal(options.redirect, 'error')
      return response(queue.shift())
    },
    async (ms) => sleeps.push(ms),
  )
  const zip = Buffer.from('zip bytes')
  await client.upload(zip, '1.2.3')
  assert.equal(await client.publish(), 'PENDING_REVIEW')
  const name = `publishers/publisher-fixture/items/${itemId}`
  assert.equal(calls[0].url, `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['Content-Type'], 'application/zip')
  assert.equal(calls[0].body, zip)
  assert.equal(calls[1].url, `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`)
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[3].url, `https://chromewebstore.googleapis.com/v2/${name}:publish`)
  assert.deepEqual(JSON.parse(calls[3].body), {
    publishType: 'DEFAULT_PUBLISH',
    skipReview: false,
    blockOnWarnings: true,
  })
  assert.deepEqual(sleeps, [3000, 3000])
})

test('上传失败、不明状态、处理超时和版本不符都阻止送审', async () => {
  for (const upload of [
    { uploadState: 'FAILED' },
    {},
    { uploadState: 'SUCCEEDED', crxVersion: 'wrong' },
    { uploadState: 'IN_PROGRESS' },
  ]) {
    let calls = 0
    const client = storeClient(
      'publisher',
      'fake',
      async () => {
        calls++
        return response(calls === 1 ? upload : { lastAsyncUploadState: 'IN_PROGRESS' })
      },
      async () => {},
    )
    await assert.rejects(client.upload(Buffer.from('zip'), '1.2.3'))
    assert.equal(calls, upload.uploadState === 'IN_PROGRESS' ? 21 : 1)
  }
})

test('上传和送审写请求均不盲重试，拒绝/未知发布状态不能算成功', async () => {
  let calls = 0
  const client = storeClient('publisher', 'TOP_SECRET', async () => {
    calls++
    return response({ error: 'TOP_SECRET' }, 503)
  })
  await assert.rejects(client.upload(Buffer.from('zip'), '1.2.3'), /HTTP 503/)
  await assert.rejects(client.publish(), (e) => !e.message.includes('TOP_SECRET'))
  assert.equal(calls, 2)
  for (const state of ['REJECTED', 'STAGED', 'ITEM_STATE_UNSPECIFIED']) {
    const other = storeClient('publisher', 'fake', async () => response({ state }))
    await assert.rejects(other.publish(), /未确认送审/)
  }
})
