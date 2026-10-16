import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { NativeFiles, sessionDirectory } from '../src/native-files.mjs'
import { finishTool, projectHistory } from '../src/projection.mjs'
import { dispatch } from '../src/protocol.mjs'
import { SessionManager } from '../src/sdk.mjs'
import { PiServer } from '../src/server.mjs'
import type { PiThread } from '../src/store.mjs'
import { installedVersions, validateInstalledVersions } from '../src/versions.mjs'
import { assertNotification, assertResponse } from './schema.mjs'

test('Desktop initialize 与 CLI 探测均报告固定 Codex 协议版本，Pi 仅作为 originator', async () => {
  const peer = { id: 'version', send() {}, close() {} }
  const response = await dispatch({} as PiServer, peer, 'initialize', {
    clientInfo: { name: 'codex-app', version: 'desktop-test' },
  })
  assertResponse('initialize', response)
  const reported = response.userAgent.match(/^[^/]+\/([^ ]+)/)?.[1]
  assert.equal(reported, '0.157.1')
  assert.match(response.userAgent, /\) codex-harness-adapter-pi \(codex-app; desktop-test\)$/)
  const cli = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../src/adapter.mjs', import.meta.url)), '--version'],
    { encoding: 'utf8' },
  )
  assert.equal(cli.trim(), `codex-cli ${reported} (codex-harness-adapter-pi)`)
})

test('Plan 命令只通知不启动时结束失败回合，停止不占锁', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-review-plan-'))
  const server = new PiServer(root)
  const peer = { id: 'peer', send() {}, close() {} }
  const thread: PiThread = {
    id: 'plan',
    cwd: root,
    path: null,
    name: null,
    preview: '',
    createdAt: 1,
    updatedAt: 1,
    ephemeral: true,
    model: null,
    effort: null,
    planMode: true,
    dynamicTools: [],
    forkedFromId: null,
  }
  const sessionManager = SessionManager.inMemory(root)
  sessionManager.appendCustomEntry('plan-mode-state', {
    enabled: true,
    latestPlan: 'proposed plan',
  })
  const live: any = {
    session: {
      sessionManager,
      isIdle: true,
      subscribe: () => () => {},
      prompt: async () => {
        server.active.get(thread.id)!.notices!.push('插件拒绝实施：工作流占用')
      },
      waitForIdle: async () => {},
      clearQueue() {},
      abort: async () => {},
    },
    waitForExtensionInputs: async () => {},
    dispose: async () => {},
  }
  server.load = async () => live
  server.peers.set(peer.id, peer)
  server.store.saveThread(thread)
  try {
    const turn = server.start(peer, thread, {
      input: [{ type: 'text', text: 'implement' }],
      collaborationMode: { mode: 'default' },
      clientUserMessageId: 'plan:blocked',
    })
    await server.active.get(thread.id)!.done
    assert.equal(turn.status, 'failed')
    assert.match(turn.error!.message, /插件拒绝实施/)
    await server.interrupt(thread.id)
    assert.equal(server.active.size, 0)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('反向请求取消发 resolved，发起端断线后新问答路由给其他订阅端', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-review-reverse-'))
  const server = new PiServer(root)
  const messages: any[] = []
  const first = { id: 'first', send() {}, close() {} }
  const second = {
    id: 'second',
    send(m: any) {
      messages.push(m)
    },
    close() {},
  }
  for (const peer of [first, second]) {
    server.peers.set(peer.id, peer)
    server.subscribe(peer, 't')
  }
  try {
    const abort = new AbortController()
    const cancelled = server.call(first, 't', 'item/tool/call', {}, abort.signal)
    abort.abort()
    await assert.rejects(cancelled, /已取消/)
    assert.ok(messages.some((m) => m.method === 'serverRequest/resolved'))
    const lost = server.call(first, 't', 'item/tool/call', {})
    server.closePeer(first)
    await assert.rejects(lost, /客户端已断开/)
    assert.equal(messages.filter((m) => m.method === 'serverRequest/resolved').length, 2)
    const next = server.call(first, 't', 'item/tool/call', {})
    const request = messages.findLast((m) => m.method === 'item/tool/call')
    assert.ok(request?.id)
    await server.handle(second, { jsonrpc: '2.0', id: request.id, result: { success: true } })
    assert.deepEqual(await next, { success: true })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('原生索引按文件状态缓存，设置使用官方 sessionDir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-review-index-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  try {
    const path = join(root, 'sample.jsonl'),
      files = new NativeFiles()
    await writeFile(path, '{"v":1}\n')
    const first = files.read(path)
    assert.strictEqual(files.read(path), first)
    await writeFile(path, '{"v":2}\n')
    assert.notStrictEqual(files.read(path), first)
    assert.equal(files.read(path)[0].v, 2)
    const directory = join(root, 'custom-sessions')
    await writeFile(join(root, 'settings.json'), JSON.stringify({ sessionDir: directory }))
    assert.equal(sessionDirectory(root), directory)
    const manager = SessionManager.create(root, sessionDirectory(root))
    assert.equal(manager.getSessionDir(), directory)
    manager.appendMessage({ role: 'user', content: 'native', timestamp: Date.now() })
    manager.appendMessage({
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: 'mock',
      model: 'mock',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    })
    const original = await readFile(manager.getSessionFile()!, 'utf8')
    const server = new PiServer(join(root, 'adapter'))
    try {
      await server.index()
      assert.ok(server.store.threads().some((t) => t.id === manager.getSessionId()))
      assert.equal(server.sessions.size, 0)
      assert.equal(await readFile(manager.getSessionFile()!, 'utf8'), original)
    } finally {
      await server.close()
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('诊断读取实际包版本，接受更高版本，拒绝每个随适配器分发的插件低于下限', () => {
  const installed = installedVersions()
  validateInstalledVersions(installed)
  for (const name of Object.keys(installed)) {
    validateInstalledVersions({ ...installed, [name]: '999.0.0' })
    assert.throws(() => validateInstalledVersions({ ...installed, [name]: '0.0.0' }), /版本不符/)
  }
})

test('edit 使用官方 unified patch，不投影带行号的展示 diff', () => {
  const item: any = { type: 'fileChange', changes: [] }
  finishTool(
    item,
    { details: { diff: '-1 old\n+1 new', patch: '--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n' } },
    false,
    { path: 'a' },
  )
  assert.match(item.changes[0].diff, /^--- a/)
  assert.equal(item.changes[0].kind.type, 'update')
})

test('旧 write 历史的 add 使用正文，十字节无换行不会把 diff 头统计为五行', () => {
  for (const content of ['1234567890', '', 'one\ntwo\n']) {
    const entries = [
      {
        type: 'message',
        id: 'a',
        message: {
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'a.txt', content } },
          ],
        },
      },
      {
        type: 'custom',
        customType: 'codex-harness-adapter-file-change',
        data: {
          id: 'write',
          changes: [
            {
              path: 'a.txt',
              kind: { type: 'add' },
              diff: '--- /dev/null\n+++ a.txt\n@@ -0,0 +1 @@\n+1234567890\n\\ No newline at end of file\n',
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'b',
        message: { role: 'toolResult', timestamp: 2, toolCallId: 'write', content: [] },
      },
    ]
    const before = JSON.stringify(entries)
    const turns = projectHistory(entries, { id: 't', cwd: '/tmp' } as PiThread)
    assert.equal(turns[0]!.items[0].changes[0].diff, content)
    assert.equal(JSON.stringify(entries), before, '修复历史投影不能改写原生 JSONL')
  }
})

test('shellCommand 即刻响应，长命令不阻塞 interrupt 且输出符合 schema', {
  timeout: 5000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-review-shell-'))
  const server = new PiServer(root)
  const messages: any[] = []
  let output = () => {}
  const emitted = new Promise<void>((resolve) => {
    output = resolve
  })
  const peer = {
    id: 'shell',
    close() {},
    send(message: any) {
      messages.push(message)
      if (message.method === 'command/exec/outputDelta') {
        assertNotification(message.method, message.params)
        output()
      }
    },
  }
  server.store.saveThread({
    id: 'shell-thread',
    cwd: root,
    path: null,
    name: null,
    preview: '',
    createdAt: 1,
    updatedAt: 1,
    ephemeral: true,
    model: null,
    effort: null,
    planMode: false,
    dynamicTools: [],
    forkedFromId: null,
  })
  try {
    await server.handle(peer, {
      jsonrpc: '2.0',
      id: 1,
      method: 'thread/shellCommand',
      params: {
        threadId: 'shell-thread',
        command: 'while [ ! -f release ]; do sleep 0.05; done; printf output',
      },
    })
    assert.deepEqual(messages.find((m) => m.id === 1).result, {})
    assertResponse('thread/shellCommand', messages.find((m) => m.id === 1).result)
    await server.handle(peer, {
      jsonrpc: '2.0',
      id: 2,
      method: 'turn/interrupt',
      params: { threadId: 'shell-thread' },
    })
    assert.deepEqual(messages.find((m) => m.id === 2).result, {})
    assert.equal(server.sessions.size, 0)
    await writeFile(join(root, 'release'), '')
    await emitted
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
