// 显式运行：TEST_ANTIGRAVITY_BINARY 指向已校验 0.1.23；没有程序就失败，不跳过，不用真实账号。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspect } from '../../../shared/test/strict-wire.mjs'
import { verifyBinary } from '../../src/install.mjs'
import { LocalHarness } from '../../src/runtime.mjs'
import { fixture } from './fixture.mjs'

const binary = process.env.TEST_ANTIGRAVITY_BINARY
if (!binary) throw new Error('请提供 TEST_ANTIGRAVITY_BINARY；测试只连接回环假 Gemini')
await verifyBinary(binary)
for (const mode of [
  'stream',
  'allow',
  'deny',
  'cancel',
  'interrupt',
  'expired',
  'file-allow',
  'file-deny',
])
  test(`真实 localharness + 假 Gemini: ${mode}`, async () => {
    const requests: any[] = []
    let home = ''
    const http = createServer(async (req, res) => {
      const parts: Buffer[] = []
      for await (const chunk of req) parts.push(chunk)
      const body = JSON.parse(Buffer.concat(parts).toString())
      requests.push(body)
      assert.equal(req.headers['x-goog-api-key'], 'fake-key')
      assert.match(req.url ?? '', /streamGenerateContent/)
      if (mode === 'expired') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { code: 401, message: 'API key expired: fake-key', status: 'UNAUTHENTICATED' },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode === 'interrupt') {
        res.write(
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'in progress' }] }, index: 0 }] })}\n\n`,
        )
        return
      }
      const chunk = (parts: unknown[], finish = false) =>
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, index: 0, ...(finish ? { finishReason: 'STOP' } : {}) }], ...(finish ? { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } } : {}) })}\n\n`
      if (mode !== 'stream' && requests.length === 1) {
        const file = mode.startsWith('file-')
        res.end(
          chunk(
            [
              {
                functionCall: file
                  ? {
                      name: 'write_to_file',
                      args: {
                        TargetFile: join(home, 'created.txt'),
                        CodeContent: 'file mock',
                        EmptyFile: false,
                        Overwrite: false,
                      },
                    }
                  : {
                      name: 'run_command',
                      args: { CommandLine: 'printf mock', Cwd: home, WaitMsBeforeAsync: 1000 },
                    },
              },
            ],
            true,
          ),
        )
      } else {
        res.write(chunk([{ text: 'Hello ' }]))
        setTimeout(() => res.end(chunk([{ text: 'mock.' }], true)), 30)
      }
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const f = await fixture({
      executable: async () => binary,
      runtime(options) {
        return new LocalHarness({ ...options, env: { PATH: '/usr/bin:/bin' } })
      },
    })
    home = f.home
    try {
      const config = f.server.config.read()
      f.server.config.write({
        expectedVersion: config.version,
        edits: [{ key: 'baseUrl', value: `http://127.0.0.1:${address.port}` }],
      })
      const { thread } = await f.call('thread/start', { cwd: f.home })
      await f.call('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'mock request' }],
      })
      if (['allow', 'deny', 'cancel', 'file-allow', 'file-deny'].includes(mode)) {
        const request = await f.wait(
          mode.startsWith('file-')
            ? 'item/fileChange/requestApproval'
            : 'item/commandExecution/requestApproval',
        )
        await f.server.handle(f.peer, {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            decision: mode.endsWith('allow')
              ? 'accept'
              : mode.endsWith('deny')
                ? 'decline'
                : 'cancel',
          },
        })
      }
      if (mode === 'interrupt') {
        await f.wait('item/agentMessage/delta')
        await f.call('turn/interrupt', { threadId: thread.id })
      }
      const turn = (await f.wait('turn/completed')).params.turn
      assert.equal(
        turn.status,
        ['interrupt', 'cancel'].includes(mode)
          ? 'interrupted'
          : mode === 'expired'
            ? 'failed'
            : 'completed',
      )
      if (mode === 'expired') assert.match(turn.error.message, /API key/)
      if (turn.status === 'completed') {
        assert.equal(
          turn.items.filter((item: any) => item.type === 'agentMessage').at(-1)?.text,
          'Hello mock.',
        )
        assert.equal(requests.length, mode === 'stream' ? 1 : 2)
      }
      if (mode === 'allow')
        assert.equal(
          turn.items.find((item: any) => item.type === 'commandExecution')?.aggregatedOutput,
          'mock',
        )
      if (mode === 'file-allow')
        assert.equal(await readFile(join(home, 'created.txt'), 'utf8'), 'file mock\n')
      if (mode === 'file-deny')
        await assert.rejects(readFile(join(home, 'created.txt')), { code: 'ENOENT' })
      if (['cancel', 'interrupt'].includes(mode)) {
        assert.equal(turn.error, null)
        assert.equal(requests.length, 1)
      }
      // 已持久化的索引不包含 key；同进程的第二回合仍能继续。
      assert.ok(
        !(await readFile(join(home, 'threads', `${thread.id}.json`), 'utf8')).includes('fake-key'),
      )
      if (mode === 'stream') {
        await f.server.close()
        const { AntigravityServer } = await import('../../src/server.mjs')
        const resumed = new AntigravityServer(home, {
          env: { GEMINI_API_KEY: 'fake-key' },
          executable: async () => binary,
        })
        try {
          await resumed.open(resumed.store.get(thread.id))
          assert.equal(resumed.store.get(thread.id).turns[0]?.status, 'completed')
        } finally {
          await resumed.close()
        }
      }
      assert.deepEqual(
        f.messages.flatMap(({ jsonrpc: _jsonrpc, ...message }) =>
          inspect(message, (id) => f.methods.get(id as number)),
        ),
        [],
      )
    } finally {
      await f.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })
