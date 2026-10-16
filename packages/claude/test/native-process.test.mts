import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const full = { sandboxPolicy: { type: 'dangerFullAccess' } }

test('FILES-003：真实进程的输入、退出、输出上限和终止', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const result = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: ['/bin/sh', '-c', 'printf abcdef; printf stderr >&2; exit 7'],
      outputBytesCap: 3,
    })
    assert.deepEqual(result, { exitCode: 7, stdout: 'abc', stderr: 'std' })
    const command = client.request('command/exec', {
      ...full,
      processId: 'input',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf READY; cat > input.txt; printf FINISHED'],
      streamStdin: true,
      streamStdoutStderr: true,
      outputBytesCap: 6,
    })
    await client.notification('command/exec/outputDelta', (value) => value.processId === 'input')
    const duplicate = await client.raw('command/exec', {
      ...full,
      processId: 'input',
      cwd: home,
      command: ['true'],
    })
    assert.equal(duplicate.error.code, -32600)
    assert.equal(duplicate.error.message, 'duplicate active command/exec process id: "input"')
    await client.request('command/exec/write', {
      processId: 'input',
      deltaBase64: Buffer.from('二进制\0输入').toString('base64'),
      closeStdin: true,
    })
    assert.deepEqual(await command, { exitCode: 0, stdout: '', stderr: '' })
    assert.equal(await readFile(join(home, 'input.txt'), 'utf8'), '二进制\0输入')
    const chunks = client.trace.filter(
      (message) =>
        message.method === 'command/exec/outputDelta' && message.params.processId === 'input',
    )
    assert.equal(
      Buffer.concat(
        chunks.map((message) => Buffer.from(message.params.deltaBase64, 'base64')),
      ).toString(),
      'READYF',
    )
    assert.equal(chunks.at(-1).params.capReached, true)
    // 所有输出必须先于 command 最终响应，不能靠补读通知凑齐。
    assert.ok(
      client.trace.indexOf(chunks.at(-1)) <
        client.trace.findIndex((message) => message.result?.exitCode === 0),
    )

    await client.request('process/spawn', {
      processHandle: 'held',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf SPAWNED; read line; printf "%s" "$line"'],
      streamStdin: true,
      streamStdoutStderr: true,
    })
    await client.notification('process/outputDelta', (value) => value.processHandle === 'held')
    await client.request('process/writeStdin', {
      processHandle: 'held',
      deltaBase64: Buffer.from('answer\n').toString('base64'),
    })
    assert.equal(
      (await client.notification('process/exited', (value) => value.processHandle === 'held'))
        .exitCode,
      0,
    )
    await client.request('process/spawn', {
      processHandle: 'stop',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf RUNNING; sleep 30; touch must-not-exist'],
      streamStdoutStderr: true,
    })
    await client.notification('process/outputDelta', (value) => value.processHandle === 'stop')
    await client.request('process/kill', { processHandle: 'stop' })
    assert.notEqual(
      (await client.notification('process/exited', (value) => value.processHandle === 'stop'))
        .exitCode,
      0,
    )
    await assert.rejects(access(join(home, 'must-not-exist')))
    const missing = await client.raw('process/spawn', {
      processHandle: 'missing',
      cwd: home,
      command: ['/nonexistent/test-command'],
    })
    assert.equal(missing.error.code, -32603)
    assert.match(missing.error.message, /^failed to spawn process: /)
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-004：PTY 初始尺寸、resize 和真实退出码', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-pty-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    for (const kind of ['command', 'process']) {
      const id = `pty-${kind}`
      const field = kind === 'command' ? 'processId' : 'processHandle'
      const prefix = kind === 'command' ? 'command/exec' : 'process'
      const started = client.request(kind === 'command' ? 'command/exec' : 'process/spawn', {
        ...(kind === 'command' ? full : {}),
        [field]: id,
        cwd: home,
        tty: true,
        size: { rows: 23, cols: 71 },
        command: ['/bin/sh', '-c', 'stty -echo; stty size; read line; stty size; exit 7'],
      })
      if (kind === 'process') await started
      const initial = await client.notification(
        `${prefix}/outputDelta`,
        (value) =>
          value[field] === id &&
          Buffer.from(value.deltaBase64, 'base64').toString().includes('23 71'),
      )
      assert.equal(initial.stream, 'stdout')
      await client.request(kind === 'command' ? 'command/exec/resize' : 'process/resizePty', {
        [field]: id,
        size: { rows: 39, cols: 107 },
      })
      await client.request(kind === 'command' ? 'command/exec/write' : 'process/writeStdin', {
        [field]: id,
        deltaBase64: Buffer.from('continue\n').toString('base64'),
      })
      const ended =
        kind === 'command'
          ? await started
          : await client.notification('process/exited', (value) => value[field] === id)
      assert.equal(ended.exitCode, 7)
      const output = client.trace
        .filter(
          (message) => message.method === `${prefix}/outputDelta` && message.params[field] === id,
        )
        .map((message) => Buffer.from(message.params.deltaBase64, 'base64').toString())
        .join('')
      assert.match(output, /39 107/)
    }
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-006：超时、立即终止、输出上限与退出后排空', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-limits-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    // 超时的退出码固定为 124，不管子进程真实返回什么。
    const timedOut = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: ['/bin/sh', '-c', 'trap "" TERM; sleep 5'],
      timeoutMs: 200,
    })
    assert.equal(timedOut.exitCode, 124)
    // 0ms 表示立即超时。
    const immediate = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: ['/bin/sh', '-c', 'sleep 5'],
      timeoutMs: 0,
    })
    assert.equal(immediate.exitCode, 124)
    // 终止立即对进程组发 SIGKILL，忽略 TERM 的进程也只能被杀死。
    const victim = client.request('command/exec', {
      ...full,
      processId: 'victim',
      cwd: home,
      command: ['/bin/sh', '-c', 'trap "" TERM; sleep 30'],
      streamStdoutStderr: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const killedAt = Date.now()
    await client.request('command/exec/terminate', { processId: 'victim' })
    assert.equal((await victim).exitCode, 137)
    assert.ok(Date.now() - killedAt < 1_000)
    // 输出上限标在触达上限的那一片上，之后不再发送。
    const capped = await client.request('command/exec', {
      ...full,
      processId: 'capped',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf abcdef'],
      streamStdoutStderr: true,
      outputBytesCap: 3,
    })
    assert.deepEqual(capped, { exitCode: 0, stdout: '', stderr: '' })
    const chunks = client.trace.filter(
      (message) =>
        message.method === 'command/exec/outputDelta' && message.params.processId === 'capped',
    )
    assert.equal(
      Buffer.concat(
        chunks.map((message) => Buffer.from(message.params.deltaBase64, 'base64')),
      ).toString(),
      'abc',
    )
    assert.equal(chunks.at(-1).params.capReached, true)
    assert.ok(chunks.every((message) => message.params.deltaBase64.length > 0))
    // 子进程退出后要把还在管道里的输出读完再返回。
    const late = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: ['/bin/sh', '-c', '(sleep 0.3; printf late) & exit 0'],
    })
    assert.equal(late.exitCode, 0)
    assert.equal(late.stdout, 'late')
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-007：env 覆盖、非继承变量过滤与 tty 的 TERM', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-env-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    // 默认继承服务进程的环境变量。
    const inherited = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: ['/bin/sh', '-c', 'printf "%s" "${DISABLE_TELEMETRY-unset}"'],
    })
    assert.equal(inherited.stdout, '1')
    // null 删除继承变量；覆盖进去的非继承变量在应用覆盖值之后被过滤。
    const filtered = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: [
        '/bin/sh',
        '-c',
        'printf "%s|%s|%s" "${DISABLE_TELEMETRY-unset}" "${NODE_REPL_AUTH_TOKEN-unset}" "$C"',
      ],
      env: { DISABLE_TELEMETRY: null, NODE_REPL_AUTH_TOKEN: 'leaked', C: 'kept' },
    })
    assert.equal(filtered.stdout, 'unset|unset|kept')
    // tty 下只用请求里的 TERM，不强制注入（用 env 直接读环境变量，避免 shell 自己补 TERM）。
    for (const value of ['xterm-9999', null] as const) {
      const id = `term-${value}`
      const started = client.request('command/exec', {
        ...full,
        processId: id,
        cwd: home,
        tty: true,
        env: { TERM: value },
        command: ['/usr/bin/env'],
      })
      assert.equal((await started).exitCode, 0)
      const lines = client.trace
        .filter(
          (message) =>
            message.method === 'command/exec/outputDelta' && message.params.processId === id,
        )
        .map((message) => Buffer.from(message.params.deltaBase64, 'base64').toString())
        .join('')
        .split(/\r?\n/)
      if (value === null) assert.ok(!lines.some((line) => line.startsWith('TERM=')))
      else assert.ok(lines.includes(`TERM=${value}`))
    }
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-008：终端方法的参数校验、标识隔离与错误文案', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-errors-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const keepAlive = ['/bin/sh', '-c', 'cat > /dev/null; sleep 30']
  try {
    await client.request('process/spawn', {
      processHandle: 'held',
      cwd: home,
      command: keepAlive,
      streamStdin: true,
      streamStdoutStderr: true,
      timeoutMs: null,
    })
    const running = client.request('command/exec', {
      ...full,
      processId: 'running',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf ready; cat > /dev/null; sleep 30'],
      streamStdin: true,
      streamStdoutStderr: true,
      disableTimeout: true,
    })
    await client.notification('command/exec/outputDelta', (value) => value.processId === 'running')
    await client.request('process/spawn', {
      processHandle: 'nostdin',
      cwd: home,
      command: keepAlive,
      timeoutMs: null,
    })
    // 不流式也没有 stdin 的 command/exec 只在退出时返回，先不等待。
    const nostdin = client.raw('command/exec', {
      ...full,
      processId: 'nostdin',
      cwd: home,
      command: keepAlive,
      disableTimeout: true,
    })
    const cases: Array<{
      name: string
      method: string
      params: Record<string, unknown>
      code: number
      message: string
    }> = [
      {
        name: 'command 为空数组',
        method: 'command/exec',
        params: { ...full, cwd: home, command: [] },
        code: -32600,
        message: 'command must not be empty',
      },
      {
        name: 'processHandle 为空字符串',
        method: 'process/spawn',
        params: { processHandle: '', cwd: home, command: ['true'] },
        code: -32600,
        message: 'processHandle must not be empty',
      },
      {
        name: '要求 tty 或流式但没有 processId',
        method: 'command/exec',
        params: { ...full, cwd: home, tty: true, command: ['true'] },
        code: -32600,
        message: 'command/exec tty or streaming requires a client-supplied processId',
      },
      {
        name: 'process 重复标识',
        method: 'process/spawn',
        params: { processHandle: 'held', cwd: home, command: ['true'] },
        code: -32600,
        message: 'duplicate active process handle: "held"',
      },
      {
        name: 'command 重复标识',
        method: 'command/exec',
        params: { ...full, processId: 'running', cwd: home, command: ['true'] },
        code: -32600,
        message: 'duplicate active command/exec process id: "running"',
      },
      {
        name: 'process 指定 size 但不是 tty',
        method: 'process/spawn',
        params: {
          processHandle: 'size',
          cwd: home,
          command: ['true'],
          size: { rows: 24, cols: 80 },
        },
        code: -32602,
        message: 'process/spawn size requires tty: true',
      },
      {
        name: 'command 指定 size 但不是 tty',
        method: 'command/exec',
        params: { ...full, cwd: home, command: ['true'], size: { rows: 24, cols: 80 } },
        code: -32602,
        message: 'command/exec size requires tty: true',
      },
      {
        name: 'process 行列为 0',
        method: 'process/spawn',
        params: {
          processHandle: 'zero',
          cwd: home,
          tty: true,
          command: ['true'],
          size: { rows: 0, cols: 80 },
        },
        code: -32602,
        message: 'process size rows and cols must be greater than 0',
      },
      {
        name: 'command 行列为 0',
        method: 'command/exec',
        params: {
          ...full,
          processId: 'zero',
          cwd: home,
          tty: true,
          command: ['true'],
          size: { rows: 24, cols: 0 },
        },
        code: -32602,
        message: 'command/exec size rows and cols must be greater than 0',
      },
      {
        name: 'process timeoutMs 为负数',
        method: 'process/spawn',
        params: { processHandle: 'negative', cwd: home, command: ['true'], timeoutMs: -1 },
        code: -32602,
        message: 'process/spawn timeoutMs must be non-negative, got -1',
      },
      {
        name: 'command timeoutMs 为负数',
        method: 'command/exec',
        params: { ...full, cwd: home, command: ['true'], timeoutMs: -1 },
        code: -32602,
        message: 'command/exec timeoutMs must be non-negative, got -1',
      },
      {
        name: '同时给 outputBytesCap 和 disableOutputCap',
        method: 'command/exec',
        params: {
          ...full,
          cwd: home,
          command: ['true'],
          outputBytesCap: 10,
          disableOutputCap: true,
        },
        code: -32602,
        message: 'command/exec cannot set both outputBytesCap and disableOutputCap',
      },
      {
        name: '同时给 timeoutMs 和 disableTimeout',
        method: 'command/exec',
        params: { ...full, cwd: home, command: ['true'], timeoutMs: 10, disableTimeout: true },
        code: -32602,
        message: 'command/exec cannot set both timeoutMs and disableTimeout',
      },
      {
        name: 'process 标识不存在',
        method: 'process/writeStdin',
        params: { processHandle: 'ghost', deltaBase64: 'eA==' },
        code: -32600,
        message: 'no active process for process handle "ghost"',
      },
      {
        name: 'command 标识不存在',
        method: 'command/exec/terminate',
        params: { processId: 'ghost' },
        code: -32600,
        message: 'no active command/exec for process id "ghost"',
      },
      {
        name: 'process write 缺少 deltaBase64 和 closeStdin',
        method: 'process/writeStdin',
        params: { processHandle: 'held' },
        code: -32602,
        message: 'process/writeStdin requires deltaBase64 or closeStdin',
      },
      {
        name: 'command write 缺少 deltaBase64 和 closeStdin',
        method: 'command/exec/write',
        params: { processId: 'running' },
        code: -32602,
        message: 'command/exec/write requires deltaBase64 or closeStdin',
      },
      {
        name: 'process 没开启 stdin 流式',
        method: 'process/writeStdin',
        params: { processHandle: 'nostdin', deltaBase64: 'eA==' },
        code: -32600,
        message: 'stdin streaming is not enabled for this process',
      },
      {
        name: 'command 没开启 stdin 流式',
        method: 'command/exec/write',
        params: { processId: 'nostdin', deltaBase64: 'eA==' },
        code: -32600,
        message: 'stdin streaming is not enabled for this command/exec',
      },
      {
        name: '非 tty 进程调整尺寸',
        method: 'process/resizePty',
        params: { processHandle: 'held', size: { rows: 1, cols: 1 } },
        code: -32600,
        message: 'failed to resize PTY: process is not attached to a PTY',
      },
    ]
    for (const item of cases) {
      const response = await client.raw(item.method, item.params)
      assert.equal(response.error?.code, item.code, item.name)
      assert.equal(response.error?.message, item.message, item.name)
    }
    // 关闭 stdin 之后再写数据才报错，重复 closeStdin 不报错。
    await client.request('process/writeStdin', { processHandle: 'held', closeStdin: true })
    await client.request('process/writeStdin', { processHandle: 'held', closeStdin: true })
    await client.request('command/exec/terminate', { processId: 'nostdin' })
    assert.equal((await nostdin).result.exitCode, 137)
    const closed = await client.raw('process/writeStdin', {
      processHandle: 'held',
      deltaBase64: 'eA==',
    })
    assert.equal(closed.error?.code, -32600)
    assert.equal(closed.error?.message, 'stdin is already closed')
    // 启动失败报 -32603，并且不会占用标识。
    for (const [method, params, prefix] of [
      [
        'process/spawn',
        { processHandle: 'missing', cwd: home, command: ['/nonexistent/test-command'] },
        'failed to spawn process: ',
      ],
      [
        'command/exec',
        {
          ...full,
          processId: 'missing-tty',
          cwd: home,
          tty: true,
          command: ['/nonexistent/test-command'],
        },
        'failed to spawn command: ',
      ],
    ] as const) {
      const failed = await client.raw(method, params)
      assert.equal(failed.error?.code, -32603)
      assert.ok(failed.error?.message.startsWith(prefix), failed.error?.message)
    }
    const retry = await client.raw('command/exec', {
      ...full,
      processId: 'missing-tty',
      cwd: home,
      tty: true,
      command: ['/bin/sh', '-c', 'exit 0'],
    })
    assert.equal(retry.result?.exitCode, 0)
    await client.request('command/exec/terminate', { processId: 'running' })
    assert.equal((await running).exitCode, 137)
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-005：关闭适配器后不遗留忽略 TERM 的后台孙进程', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-cleanup-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let closed = false
  try {
    const result = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: [
        '/bin/sh',
        '-c',
        '(trap "" TERM; touch ready; sleep 2; touch escaped) >/dev/null 2>&1 & while [ ! -e ready ]; do sleep 0.01; done; printf finished',
      ],
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'finished')
    await client.close()
    closed = true
    await new Promise((resolve) => setTimeout(resolve, 2200))
    await assert.rejects(access(join(home, 'escaped')))
    assert.equal(model.requests.length, 0)
  } finally {
    if (!closed) await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
