// 真实 agy 经 Litch 的权限路径：同一回合内切换，模型只连接回环服务。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { AcpServer } from '../../src/server.mjs'
import { client, dispose, isolate, text, turn, violations } from '../client.mjs'

const binary = process.env.TEST_AGY_CLI
if (!binary) throw new Error('请提供 TEST_AGY_CLI；不使用真实账号')

test('真实 agy 同一回合完全访问 → Default → 完全访问，仅中间一次弹卡', async () => {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy' })
  let desktop: ReturnType<typeof client>
  let id = ''
  let calls = 0
  const failures: unknown[] = []
  const http = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const main = body.tools?.some((tool: any) =>
        tool.functionDeclarations?.some((entry: any) => entry.name === 'run_command'),
      )
      if (main) calls++
      const invoke = main && calls <= 3
      if (invoke)
        await desktop.call('thread/settings/update', {
          threadId: id,
          permissions: calls === 2 ? 'acp:mode:default' : ':danger-full-access',
        })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: invoke
                  ? [
                      {
                        functionCall: {
                          name: 'run_command',
                          args: {
                            CommandLine: `printf permission-${calls}`,
                            toolSummary: 'Permission probe',
                            WaitMsBeforeAsync: 1000,
                          },
                        },
                      },
                    ]
                  : [{ text: 'done' }],
              },
              index: 0,
              finishReason: 'STOP',
            },
          ],
        })}\n\n`,
      )
    } catch (error) {
      failures.push(error)
      response.writeHead(500)
      response.end()
    }
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  assert.ok(address && typeof address !== 'string')
  const server = new AcpServer(isolated.home, {
    PATH: process.env.PATH,
    HOME: isolated.root,
    XDG_CONFIG_HOME: isolated.root,
    XDG_STATE_HOME: isolated.root,
    XDG_CACHE_HOME: isolated.root,
    CHA_ACP_AGENT: 'agy',
    CHA_AGY_CLI: binary,
    CHA_AGY_ARGS: 'acp --disable-telemetry',
    GEMINI_API_KEY: 'fake-local-key',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
  })
  desktop = client(server)
  const s = { ...isolated, server, desktop }
  try {
    await desktop.call('initialize', {
      capabilities: { litchExtensions: ['acpControls', 'threadCapabilities'] },
    })
    await desktop.call('litch/acp/auth/authenticate', { methodId: 'gemini-api-key' })
    const started = await desktop.call('thread/start', {
      cwd: s.cwd,
      permissions: ':danger-full-access',
    })
    id = started.thread.id
    desktop.onRequest(() => ({ decision: 'accept' }))
    const done = await turn(s, id, text('Run three probe commands.'))
    assert.equal(done.status, 'completed')
    assert.deepEqual(failures, [])
    assert.equal(calls, 4)
    assert.equal(desktop.requests.length, 1)
    assert.equal(desktop.requests[0].params.command, 'printf permission-2')
    assert.equal(
      done.items.filter((item: any) => item.type === 'commandExecution' && item.exitCode === 0)
        .length,
      3,
    )
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
})
