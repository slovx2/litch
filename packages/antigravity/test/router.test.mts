import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { acpModuleUrl, type Backend } from '../src/backend-loader.mjs'
import { decodeThread, rewriteThreads } from '../src/id-space.mjs'
import { AntigravityRouter } from '../src/router.mjs'

class FakeBackend implements Backend {
  readonly calls: Array<{ method: string; params: any }> = []
  closed = false
  constructor(readonlyId: 'sdk' | 'acp') {
    this.backendId = readonlyId
  }
  readonly backendId: 'sdk' | 'acp'
  peer: RpcPeer | undefined
  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if (!('method' in message) || !('id' in message)) {
      this.calls.push({ method: 'response', params: message })
      return
    }
    this.peer = peer
    const p = message.params as any
    this.calls.push({ method: message.method, params: p })
    const thread = {
      id: 'same',
      sessionId: 'same',
      cwd: '/workspace',
      createdAt: 1,
      updatedAt: this.backendId === 'sdk' ? 1 : 2,
      preview: this.backendId,
      turns: [],
    }
    let result: any = {}
    if (message.method === 'runtime/info')
      result = {
        engine: this.backendId,
        extensions: [],
        features: { fork: this.backendId === 'acp' },
      }
    if (['thread/start', 'thread/read', 'thread/resume'].includes(message.method))
      result = { thread }
    if (message.method === 'thread/list') result = { data: [thread], nextCursor: null }
    if (message.method === 'thread/loaded/list') result = { data: ['same'], nextCursor: null }
    if (message.method === 'litch/harness/config/read')
      result = { groups: [], settings: [], values: {}, files: [], actions: [], version: '1' }
    peer.send({ jsonrpc: '2.0', id: message.id, result })
  }
  closePeer(): void {}
  async close(): Promise<void> {
    this.closed = true
  }
}
async function setup(declare = true) {
  const home = await mkdtemp(join(tmpdir(), 'agy-router-'))
  const sdk = new FakeBackend('sdk'),
    acp = new FakeBackend('acp')
  const router = new AntigravityRouter(home, { sdk, acp: async () => acp, env: {} })
  const messages: any[] = []
  const peer: RpcPeer = {
    id: 'p',
    close() {},
    send(message) {
      messages.push(message)
    },
  }
  let id = 0
  const call = async (method: string, params: any = {}) => {
    const request = ++id
    await router.handle(peer, { id: request, method, params })
    const result = messages.find((message) => message.id === request && !message.method)
    if (result.error) throw new Error(result.error.message)
    return result.result
  }
  await call('initialize', {
    capabilities: { litchExtensions: declare ? ['threadCapabilities'] : [] },
  })
  return {
    home,
    sdk,
    acp,
    router,
    peer,
    messages,
    call,
    async close() {
      await router.close()
      await rm(home, { force: true, recursive: true })
    },
  }
}
test('同名后端会话隔离、切换鉴权只影响新建、合并分页和原后端恢复', async () => {
  const f = await setup()
  try {
    f.router.settings.write('apiKey')
    const sdk = await f.call('thread/start')
    assert.equal(sdk.thread.id, 'agy:sdk:same')
    const config = await f.call('litch/harness/config/read')
    await f.call('litch/harness/config/write', {
      expectedVersion: config.version,
      edits: [{ key: 'authenticationMode', value: 'subscription' }],
    })
    const acp = await f.call('thread/start')
    assert.equal(acp.thread.id, 'agy:acp:same')
    await f.call('thread/resume', { threadId: sdk.thread.id })
    assert.ok(
      f.sdk.calls.some(
        (call) => call.method === 'thread/resume' && call.params.threadId === 'same',
      ),
    )
    const page = await f.call('thread/list', { limit: 1 })
    assert.equal(page.data[0].id, 'agy:acp:same')
    assert.equal(
      (await f.call('thread/list', { limit: 1, cursor: page.nextCursor })).data[0].id,
      'agy:sdk:same',
    )
    assert.deepEqual((await f.call('thread/loaded/list')).data, ['agy:sdk:same', 'agy:acp:same'])
    assert.equal(sdk.thread.litchCapabilities.features.fork, false)
    assert.equal(acp.thread.litchCapabilities.features.fork, true)
    await assert.rejects(f.call('thread/read', { threadId: 'same' }), /前缀/)
  } finally {
    await f.close()
  }
  assert.ok(f.sdk.closed && f.acp.closed)
})
test('通知与审批双向改写，原请求号同名不串后端，未声明者不收能力字段', async () => {
  const f = await setup(false)
  try {
    f.router.settings.write('apiKey')
    const response = await f.call('thread/start')
    assert.equal(response.thread.litchCapabilities, undefined)
    f.sdk.peer?.send({
      id: '1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'same', itemId: 'i' },
    })
    const request = f.messages.at(-1)
    assert.equal(request.params.threadId, 'agy:sdk:same')
    await f.router.handle(f.peer, {
      jsonrpc: '2.0',
      id: request.id,
      result: { decision: 'accept' },
    })
    assert.equal(f.sdk.calls.at(-1)?.params.id, '1')
    assert.equal(f.acp.calls.length, 0)
    f.sdk.peer?.send({
      method: 'serverRequest/resolved',
      params: { threadId: 'same', requestId: '1' },
    })
    assert.equal(f.messages.at(-1).params.requestId, request.id)
  } finally {
    await f.close()
  }
})
test('ID 转换不改用户文字或任意工具参数', () => {
  const value = {
    threadId: 'agy:sdk:abc',
    input: [{ text: 'agy:acp:def' }],
    arguments: { threadId: 'agy:acp:def' },
  }
  assert.deepEqual(rewriteThreads(value, 'sdk', false), { ...value, threadId: 'abc' })
  assert.throws(() => decodeThread('agy:other:123'))
})
test('从安装包同构目录动态加载 ACP，状态目录和 API key 隔离', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-packed-'))
  try {
    const root = join(home, 'libexec/packages')
    const source = join(root, 'antigravity/dist/antigravity/src/backend-loader.mjs')
    const expected = join(root, 'acp/dist/acp/src/server.mjs')
    await mkdir(join(expected, '..'), { recursive: true })
    await mkdir(join(source, '..'), { recursive: true })
    await cp(new URL('../src/backend-loader.mjs', import.meta.url), source)
    await writeFile(
      expected,
      'export class AcpServer { constructor(home,env){this.home=home;this.env=env} async close(){} }',
    )
    const packed = await import(pathToFileURL(source).href)
    assert.equal(packed.acpModuleUrl().href, pathToFileURL(await realpath(expected)).href)
    assert.equal(acpModuleUrl(pathToFileURL(source).href).href, pathToFileURL(expected).href)
    const backend = await packed.loadAcp(join(home, 'state'), {
      GEMINI_API_KEY: 'fake-key',
      CHA_AGY_CLI: '/agy',
    })
    assert.equal(backend.home, join(home, 'state/acp'))
    assert.equal(backend.env.GEMINI_API_KEY, undefined)
    assert.equal(backend.env.CHA_ACP_AGENT, 'agy')
    assert.equal(backend.env.CHA_AGY_CLI, '/agy')
    await backend.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('默认订阅且没有 API key：新建、恢复、能力均只访问 ACP，不加载 SDK', async () => {
  const f = await setup()
  try {
    assert.equal(f.router.settings.mode(), 'subscription')
    assert.equal((await f.call('thread/start')).thread.id, 'agy:acp:same')
    await f.call('thread/resume', { threadId: 'agy:acp:same' })
    const info = await f.call('runtime/info')
    assert.equal(info.features.fork, true)
    assert.equal(f.sdk.calls.length, 0)
    const config = await f.call('litch/harness/config/read')
    assert.match(config.settings[0].description['zh-CN'], /账号限制风险/)
    assert.equal(config.settings[0].default, 'subscription')
  } finally {
    await f.close()
  }
})
