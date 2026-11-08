// 真实 agy 子智能体 + 回环假 Gemini：后台不推送时，Litch 有界回读并追加结果。
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AcpServer } from '../../src/server.mjs'
import { client, dispose, isolate, text, turn, violations } from '../client.mjs'

const binary = process.env.TEST_AGY_CLI
if (!binary) throw new Error('请提供 TEST_AGY_CLI；不使用真实账号')

for (const padding of [0, 256 * 1024])
  test(`真实 agy 子任务异步完成后自动追加；旧正文 ${padding} 字节`, async (t) => {
    const isolated = await isolate({ CHA_ACP_AGENT: 'agy' })
    let parentEnded = false
    let mainCalls = 0
    let childCalls = 0
    let heldChild: ServerResponse | undefined
    let heldBackground: ServerResponse | undefined
    const reply = (response: ServerResponse, parts: unknown[]) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, index: 0, finishReason: 'STOP' }] })}\n\n`,
      )
    }
    const tool = (name: string, args: unknown) => [{ functionCall: { name, args } }]
    const http = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const child = JSON.stringify(body.systemInstruction ?? '').includes('CHILD_SYSTEM_PROBE')
      const main = body.tools?.some((entry: any) =>
        entry.functionDeclarations?.some((d: any) => d.name === 'invoke_subagent'),
      )
      if (child) {
        childCalls++
        if (parentEnded) reply(response, [{ text: 'CHILD_RESULT_PROBE' }])
        else heldChild = response
        return
      }
      if (!main) return reply(response, [{ text: 'Probe title' }])
      mainCalls++
      if (mainCalls === 1)
        reply(
          response,
          tool('define_subagent', {
            Name: 'test-reader',
            Description: 'Isolated background test',
            SystemPrompt: 'CHILD_SYSTEM_PROBE. Reply CHILD_RESULT_PROBE only.',
            EnableWriteTools: false,
          }),
        )
      else if (mainCalls === 2)
        reply(
          response,
          tool('invoke_subagent', {
            TypeName: 'test-reader',
            Role: 'Background reader',
            Prompt: 'Return CHILD_RESULT_PROBE only.',
            Model: 'flash_lite',
          }),
        )
      else if (parentEnded && padding === 0) {
        heldBackground = response
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Background result' }] }, index: 0 }] })}\n\n`,
        )
      } else
        reply(response, [
          {
            text: parentEnded
              ? 'Background result received.'
              : `Started background task.${'x'.repeat(padding)}`,
          },
        ])
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
    const desktop = client(server)
    const s = { ...isolated, server, desktop }
    try {
      await desktop.call('initialize', {
        capabilities: { litchExtensions: ['acpControls', 'backgroundTasks', 'threadCapabilities'] },
      })
      await desktop.call('litch/acp/auth/authenticate', { methodId: 'gemini-api-key' })
      const created = await desktop.call('thread/start', { cwd: s.cwd })
      desktop.onRequest(() => ({ decision: 'accept' }))
      const foreground = await turn(s, created.thread.id, text('Run isolated subagent test.'))
      assert.equal(foreground.status, 'completed')
      await setImmediate()
      assert.equal(server.report.tasks(created.thread.id)[0]?.title, '子智能体可能仍在运行')
      const agent = server.runtime.current()
      assert.ok(agent)
      // 只统计回放的协议字节和耗时，不保留正文或任何凭据。
      let loadStarted = 0
      let loadBytes = 0
      let loadMs = 0
      const loadTimes: number[] = []
      let loadCount = 0
      agent.child.stdout?.on('data', (chunk) => {
        if (loadStarted) loadBytes += Buffer.byteLength(chunk)
      })
      const request = agent.connection.request.bind(agent.connection)
      agent.connection.request = async (...args: Parameters<typeof request>) => {
        if (args[0] !== 'session/load') return request(...args)
        loadCount++
        loadStarted = performance.now()
        try {
          return await request(...args)
        } finally {
          const duration = performance.now() - loadStarted
          loadMs += duration
          loadTimes.push(duration)
          loadStarted = 0
        }
      }
      parentEnded = true
      if (heldChild) reply(heldChild, [{ text: 'CHILD_RESULT_PROBE' }])
      let background = await desktop.until(
        'turn/completed',
        (p) => p.turn.litchOrigin === 'backgroundTask',
      )
      if (padding === 0) {
        assert.equal(background.turn.items[0].text, 'Background result')
        const id = background.turn.id
        const itemId = background.turn.items[0].id
        assert.ok(heldBackground)
        heldBackground.end(
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: ' received.' }] }, index: 0, finishReason: 'STOP' }] })}\n\n`,
        )
        background = await desktop.until(
          'turn/completed',
          (p) => p.turn.id === id && p.turn.items[0]?.text === 'Background result received.',
        )
        assert.equal(background.turn.items[0].id, itemId)
        assert.equal(
          desktop.notifications.filter(
            (n) => n.method === 'item/started' && n.params.item.id === itemId,
          ).length,
          1,
        )
      }
      assert.equal(
        background.turn.items
          .filter((item: any) => item.type === 'agentMessage')
          .map((item: any) => item.text)
          .join(''),
        'Background result received.',
      )
      assert.equal(server.report.tasks(created.thread.id).length, 1)
      const read = await desktop.call('thread/read', {
        threadId: created.thread.id,
        includeTurns: true,
      })
      assert.equal(read.thread.turns.length, 2)
      assert.equal(read.thread.turns[1].litchOrigin, 'backgroundTask')
      assert.equal(childCalls, 1)
      assert.equal(mainCalls, 4)
      assert.ok(loadCount > 0)
      t.diagnostic(
        `session/load：${loadCount} 次，${loadBytes} 字节，每次 ${loadTimes.map((ms) => ms.toFixed(1)).join('/')}ms，合计 ${loadMs.toFixed(1)}ms`,
      )
      assert.deepEqual([...violations], [])
    } finally {
      await dispose(s)
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })
