import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 开关从设置到运行时的最后一段：命令行那一层按设置 harness.pi.approvals 给环境变量（那一段由
// cmd/codex-harness-adapter 的 TestPiApprovalsSetting 守着），真的入口进程读它。这里起的就是那个入口，
// 只带临时目录和必要的环境，不继承宿主的模型凭据。
const ENTRY = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))

test('APPROVAL-007：入口进程按环境变量定开关：值是 1 才算开，检测时自报的和起来之后答的一致', {
  timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-approval-entry-'))
  const environment = (value: string | undefined) => ({
    PATH: process.env.PATH ?? '',
    HOME: root,
    PI_CLI: process.env.PI_CLI ?? '',
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    CHA_PI_HOME: join(root, 'state'),
    ...(value === undefined ? {} : { CHA_PI_APPROVALS: value }),
  })
  // 命令行那一层起运行时之前做检测用的就是这个参数，它报的声明进设备的 harness 名单。
  const detected = (value: string | undefined) => {
    const run = spawnSync(process.execPath, [ENTRY, '--runtime-info'], {
      encoding: 'utf8',
      env: environment(value),
      timeout: 60000,
    })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout)
  }
  // 起来之后经协议问到的。
  const served = async (value: string | undefined) => {
    const child = spawn(process.execPath, [ENTRY, 'app-server', '--listen', 'stdio://'], {
      env: environment(value),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    let diagnostics = ''
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk
    })
    try {
      const lines = createInterface({ input: child.stdout })
      const replies = new Map<number, any>()
      lines.on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id === 'number' && !message.method) replies.set(message.id, message)
      })
      const call = async (id: number, method: string, params: unknown) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        for (let waited = 0; waited < 30000 && !replies.has(id); waited += 20) {
          if (child.exitCode !== null) throw new Error(`入口提前退出: ${diagnostics}`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const reply = replies.get(id)
        assert.ok(reply, `${method} 没有应答: ${diagnostics}`)
        assert.equal(reply.error, undefined, JSON.stringify(reply.error))
        return reply.result
      }
      await call(1, 'initialize', { clientInfo: { name: 'entry', version: '0' } })
      return await call(2, 'runtime/info', {})
    } finally {
      // 标准输入一关，入口自己收场退出；没退的话直接结束它，不留进程。
      child.stdin.end()
      const forced = setTimeout(() => child.kill('SIGKILL'), 10000)
      await exited
      clearTimeout(forced)
    }
  }
  try {
    const asking = { kinds: ['command', 'fileChange'], uncovered: ['subagents'] }
    const silent = { kinds: [], uncovered: [] }
    // 后台命令的变量没给，按默认开着：声明里都带 backgroundTasks
    for (const [value, approvals, extensions] of [
      [
        undefined,
        silent,
        ['filePreview', 'planConfirmation', 'clientTools', 'harnessConfig', 'backgroundTasks'],
      ],
      [
        '0',
        silent,
        ['filePreview', 'planConfirmation', 'clientTools', 'harnessConfig', 'backgroundTasks'],
      ],
      // 只认 1：别的写法不算开，免得写错了的值悄悄变成“会问”的声明。
      [
        'true',
        silent,
        ['filePreview', 'planConfirmation', 'clientTools', 'harnessConfig', 'backgroundTasks'],
      ],
      [
        '1',
        asking,
        [
          'filePreview',
          'declineWithNote',
          'planConfirmation',
          'clientTools',
          'harnessConfig',
          'backgroundTasks',
        ],
      ],
    ] as const) {
      const before = detected(value)
      assert.deepEqual(before.features.approvals, approvals, `检测，变量是 ${value}`)
      assert.deepEqual(before.extensions, extensions, `检测，变量是 ${value}`)
    }
    for (const [value, approvals] of [
      [undefined, silent],
      ['1', asking],
    ] as const) {
      const info = await served(value)
      assert.deepEqual(info.features.approvals, approvals, `起来之后，变量是 ${value}`)
      // 检测命令额外报告宿主 CLI 路径；协议未要求运行中应答重复这项探测元数据。
      const { cliPath, ...declaration } = detected(value)
      assert.equal(typeof cliPath, 'string')
      assert.ok(isAbsolute(cliPath), '检测命令必须报告实际 CLI 的绝对路径')
      assert.deepEqual(info, declaration)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
