// 手动运行：TEST_AGY_CLI 指向官方 agy；只用隔离 HOME、假 key 和回环模型，不读取真实登录态。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AcpConnection } from '../../src/connection.mjs'

const binary = process.env.TEST_AGY_CLI
if (!binary) throw new Error('请提供 TEST_AGY_CLI；此检查不跳过，也不使用真实账号')

for (const variant of ['default', 'flag', 'setting'] as const) {
  test(`真实 agy ACP 权限：${variant}，模式切换与同进程另一会话`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'litch-agy-permissions-'))
    const configDir = join(home, '.gemini', 'antigravity-cli')
    await mkdir(configDir, { recursive: true })
    if (variant === 'setting')
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ toolPermission: 'always-proceed' }),
      )
    let issued = false
    let mainCalls = 0
    const http = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      // 自动标题也会访问模型；只给具有命令工具的主回合发工具调用。
      const main = body.tools?.some((tool: any) =>
        tool.functionDeclarations?.some((entry: any) => entry.name === 'run_command'),
      )
      const invoke = main && !issued
      if (main) mainCalls++
      if (invoke) issued = true
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
                            CommandLine: 'printf litch-permission-probe',
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
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const child = spawn(
      binary,
      [
        'acp',
        '--disable-telemetry',
        ...(variant === 'flag' ? ['--dangerously-skip-permissions'] : []),
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_STATE_HOME: join(home, 'state'),
          XDG_CACHE_HOME: join(home, 'cache'),
          GEMINI_API_KEY: 'fake-local-key',
          GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const exited = once(child, 'exit')
    child.stderr.resume()
    const approvals: any[] = []
    const updates: any[] = []
    const connection = new AcpConnection(child.stdout, child.stdin, {
      async request(method, params) {
        assert.equal(method, 'session/request_permission')
        approvals.push(params)
        const allow = params.options.find((option: any) => option.kind === 'allow_once')
        assert.ok(allow)
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      },
      notification(method, params) {
        if (method === 'session/update') updates.push(params.update)
      },
    })
    const call = (method: string, params: unknown) => connection.request(method, params, 15_000)
    try {
      const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
      assert.equal(initialized.agentInfo.name, 'Antigravity ACP Server')
      await call('authenticate', { methodId: 'gemini-api-key' })
      const first = await call('session/new', { cwd: home, mcpServers: [] })
      assert.deepEqual(
        first.modes.availableModes.map((mode: any) => mode.id),
        ['default', 'accept-edits', 'plan'],
      )
      await assert.rejects(
        call('session/set_config_option', {
          sessionId: first.sessionId,
          configId: 'mode',
          value: 'yolo',
        }),
        /Unknown mode: yolo/,
      )
      const run = async (sessionId: string) => {
        issued = false
        const count = mainCalls
        const completed = updates.filter((u) => u.status === 'completed').length
        const result = await call('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: 'run the probe command' }],
        })
        assert.equal(result.stopReason, 'end_turn')
        assert.equal(mainCalls - count, 2)
        const tools = updates.filter((u) => u.status === 'completed').slice(completed)
        assert.ok(
          tools.some(
            (u) =>
              u.rawOutput?.exit_code === 0 && u.rawOutput.output.includes('litch-permission-probe'),
          ),
        )
      }
      await run(first.sessionId)
      const changed = await call('session/set_config_option', {
        sessionId: first.sessionId,
        configId: 'mode',
        value: 'accept-edits',
      })
      assert.equal(
        changed.configOptions.find((option: any) => option.id === 'mode').currentValue,
        'accept-edits',
      )
      await run(first.sessionId)
      const second = await call('session/new', { cwd: home, mcpServers: [] })
      await run(second.sessionId)
      assert.equal(approvals.length, variant === 'default' ? 3 : 0)
    } finally {
      connection.close(new Error('验收结束'))
      child.kill('SIGKILL')
      await exited
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  })
}
