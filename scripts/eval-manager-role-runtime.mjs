// 只启动 Claude 引擎和设备聚合层，供应商配置经设备 RPC；不连接任何已有服务。
import { spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { serveAnthropic } from './client-fixture-anthropic.mjs'
import { nativeTranscripts } from './eval-manager-role-evidence.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
export const delay = pause
export const within = (root, path) => path === root || path.startsWith(root + sep)
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return join(canonical(dirname(path)), path.split(sep).at(-1))
  }
}

export async function connect(socket, writer, allowedRoots, timeoutMs = 15_000) {
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => net.createConnection(socket),
    handshakeTimeout: 10_000,
  })
  ws.on('error', () => {})
  await new Promise((done, fail) => {
    ws.once('open', done)
    ws.once('error', fail)
  })
  const frames = []
  const pending = new Map()
  const items = new Map()
  const subscribed = new Set()
  const allowed = (path) => allowedRoots.some((root) => within(root, path))
  let serial = 0
  let closed = false
  const send = (frame) => ws.send(JSON.stringify(frame))
  const call = (method, params = {}, budget = timeoutMs) =>
    new Promise((done, fail) => {
      if (closed) return fail(new Error('设备连接已关闭'))
      const id = ++serial
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(new Error(`RPC 超时：${method}`))
      }, budget)
      pending.set(id, {
        done: (value) => {
          clearTimeout(timer)
          done(value)
        },
        fail: (error) => {
          clearTimeout(timer)
          fail(error)
        },
      })
      send({ id, method, params })
    })
  ws.on('close', () => {
    closed = true
    for (const request of pending.values()) request.fail(new Error('设备连接已关闭'))
    pending.clear()
  })
  const approve = async (frame) => {
    const params = frame.params ?? {}
    let result = { decision: 'decline' }
    let reason = '非文件/命令审批，不代答产品问题或放宽权限'
    if (
      ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
        frame.method,
      )
    ) {
      const { thread } = await call('thread/read', {
        threadId: params.threadId,
        includeTurns: true,
      })
      const cwd = canonical(resolve(thread.cwd))
      const item =
        items.get(params.itemId) ??
        thread.turns?.flatMap((turn) => turn.items).find((entry) => entry.id === params.itemId)
      const targets = (item?.changes ?? []).map((change) => canonical(resolve(cwd, change.path)))
      const local = allowed(cwd) && (!params.cwd || allowed(canonical(resolve(params.cwd))))
      const fileKnown = frame.method !== 'item/fileChange/requestApproval' || targets.length > 0
      const granted = local && fileKnown && targets.every(allowed) && !params.additionalPermissions
      result = { decision: granted ? 'accept' : 'decline' }
      reason = granted
        ? '沙箱检出内单次批准；命令继续受设备 OS 沙箱约束'
        : '路径不在沙箱或目标未知/申请额外权限'
    } else if (frame.method === 'mcpServer/elicitation/request')
      result = { action: 'decline', content: null }
    else if (frame.method === 'item/tool/requestUserInput') result = { answers: {} }
    else {
      send({ id: frame.id, error: { code: -32601, message: '评测驱动不处理此服务端请求' } })
      frames.push({ at: Date.now(), direction: 'approval', method: frame.method, params, reason })
      return
    }
    frames.push(
      writer.clean({
        at: Date.now(),
        direction: 'approval',
        method: frame.method,
        params,
        result,
        reason,
      }),
    )
    send({ id: frame.id, result })
  }
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString())
    if (!frame.method) {
      const request = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) request?.fail(new Error(frame.error.message))
      else request?.done(frame.result)
      return
    }
    // 增量正文由 thread/read 的最终条目提供；不保存思考增量。
    if (!/reasoning|thinking|\/delta$/i.test(frame.method))
      frames.push(writer.clean({ at: Date.now(), ...frame }))
    if (frame.params?.item) items.set(frame.params.item.id, frame.params.item)
    const thread = frame.params?.thread
    if (
      frame.method === 'thread/started' &&
      thread?.litchManager?.role === 'line' &&
      !subscribed.has(thread.id)
    ) {
      subscribed.add(thread.id)
      // 设备派出的线必须显式订阅，才能收到工具审批和完整回合通知。
      void call('thread/resume', { threadId: thread.id, permissions: 'role-eval' }).catch(
        (error) => {
          frames.push(
            writer.clean({ at: Date.now(), subscriptionError: error.message, threadId: thread.id }),
          )
        },
      )
    }
    if (frame.id !== undefined)
      void approve(frame).catch((error) => {
        frames.push(writer.clean({ at: Date.now(), direction: 'approval', error: error.message }))
        send({ id: frame.id, error: { code: -32603, message: '审批检查失败' } })
      })
  })
  await call('initialize', {
    clientInfo: { name: 'litch-manager-role-eval', title: '经理角色评测', version: '0.0.1' },
    capabilities: {
      experimentalApi: true,
      litchExtensions: [
        'harness',
        'harnessConfig',
        'deviceWorkspaces',
        'sessionTree',
        'clientTools',
        'litchManager',
        'worktrees',
      ],
      litchClientTools: { namespaces: [] },
    },
  })
  send({ method: 'initialized' })
  return { call, frames, close: () => ws.terminate() }
}

export async function startRuntime(options, writer, registerCleanup) {
  const cli = process.env.CHA_CLAUDE_CLI
  if (!cli) throw new Error('必须设置 CHA_CLAUDE_CLI，指向隔离的 Claude CLI；不使用 PATH 上的 CLI')
  accessSync(cli, constants.X_OK)
  const root = realpathSync(mkdtempSync('/tmp/lme-'))
  const work = join(root, 'work')
  const paths = {
    root,
    work,
    cwd: join(work, 'todo-lite'),
    home: join(root, 'home'),
    claude: join(root, 'cc'),
    state: join(root, 'h'),
    codex: join(root, 'cx'),
    worktrees: join(root, 'h/device/worktrees'),
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const env = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: paths.home,
    CODEX_HOME: paths.codex,
    CLAUDE_CONFIG_DIR: paths.claude,
    CHA_CLAUDE_HOME: join(paths.state, 'claude-code'),
    CHA_CLAUDE_CLI: resolve(cli),
    CLAUDE_CODE_TMPDIR: join(root, 'ct'),
    TMPDIR: join(work, 'tmp'),
    CHA_CLAUDE_RUNTIME: 'agent-sdk-sidecar',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  mkdirSync(env.CHA_CLAUDE_HOME, { recursive: true })
  mkdirSync(env.TMPDIR, { recursive: true })
  mkdirSync(env.CLAUDE_CODE_TMPDIR, { recursive: true })
  // 默认档位给所有经理和线；写权限限于本次沙箱，密钥所在的引擎状态目录和 CLI 配置目录禁止模型工具读取。
  // 不整个禁掉临时根目录：工作树在它下面，命令的工作目录有被禁读的上级时 node 启动即中止、mkdir -p 也失败。
  const overrides = {
    approval_policy: 'on-request',
    default_permissions: 'role-eval',
    permissions: {
      'role-eval': {
        filesystem: {
          ':root': 'read',
          [env.CHA_CLAUDE_HOME]: 'deny',
          [paths.claude]: 'deny',
          [work]: 'write',
          [paths.worktrees]: 'write',
        },
        network: { enabled: false },
      },
    },
    shell_environment_policy: { inherit: 'core', ignore_default_excludes: false },
    sandbox_workspace_write: {
      writable_roots: [work, paths.worktrees],
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    },
  }
  writeFileSync(join(env.CHA_CLAUDE_HOME, 'config.json'), JSON.stringify({ overrides }), {
    mode: 0o600,
  })
  const deviceState = join(paths.state, 'device')
  mkdirSync(deviceState, { recursive: true })
  const children = []
  const logs = new Map()
  let modelServer
  let client
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    client?.close()
    for (const child of [...children].reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await Promise.race([done, pause(4000)])
      }
      // 进程组包括 CLI/守护进程；主进程先退了也要收掉剩余子进程。
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    modelServer?.closeAllConnections()
    modelServer?.close()
    try {
      nativeTranscripts(join(paths.claude, 'projects'), writer)
      for (const [name, log] of logs) writer.write(`logs/${name}.log`, log)
    } finally {
      // 密钥只存在本次创建的根内；退出（含 SIGINT）删除整棵隔离状态，不复制配置到产物。
      rmSync(root, { recursive: true, force: true })
    }
  }
  const launch = (name, args) => {
    const child = spawn(process.execPath, args, {
      cwd: work,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    const collect = (data) => logs.set(name, (logs.get(name) ?? '') + data.toString())
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => collect(error.message))
    return child
  }
  // 在启动和配置供应商期间被中断，也必须能删除临时密钥并收掉进程。
  registerCleanup(stop)
  try {
    let baseUrl = options.baseUrl
    if (options.fake) {
      modelServer = createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        await serveAnthropic('claude-code', req.url, Buffer.concat(chunks), res, 0)
      })
      await new Promise((done) => modelServer.listen(0, '127.0.0.1', done))
      baseUrl = `http://127.0.0.1:${modelServer.address().port}`
    }
    const socket = join(root, 'c.sock')
    const engine = join(repo, 'packages/claude/dist/claude/src/adapter.mjs')
    const device = join(repo, 'packages/device/dist/device/src/main.mjs')
    for (const path of [engine, device])
      if (!existsSync(path)) throw new Error('请先构建 Claude 和 device，详见驱动头部用法')
    launch('claude', [engine, 'app-server', '--listen', `unix://${socket}`])
    const deadline = Date.now() + 30_000
    while (!existsSync(socket)) {
      if (Date.now() > deadline) throw new Error('Claude 引擎启动超时，见 logs/claude.log')
      await pause(100)
    }
    const deviceSocket = join(root, 'd.sock')
    launch('device', [
      device,
      '--listen',
      `unix://${deviceSocket}`,
      '--state',
      deviceState,
      '--upstream',
      `claude-code=unix://${socket}`,
      '--wrap-up-reminder',
      'off',
    ])
    while (!logs.get('device')?.includes('LITCH_DEVICE_READY')) {
      if (Date.now() > deadline) throw new Error('设备启动超时，见 logs/device.log')
      await pause(100)
    }
    client = await connect(deviceSocket, writer, [work, paths.worktrees])
    const providers = await client.call('litch/harness/providers/read', { harness: 'claude-code' })
    await client.call('litch/harness/providers/upsert', {
      harness: 'claude-code',
      providerId: 'role-eval',
      templateId: 'anthropicGateway',
      expectedVersion: providers.version,
      definition: {
        title: '经理角色评测',
        baseUrl,
        apiKey: options.token,
        authHeader: 'bearer',
        models: [...new Set([options.model, options.smallModel])],
        smallModel: options.smallModel,
      },
    })
    const readback = await client.call('litch/harness/providers/read', { harness: 'claude-code' })
    writer.write(
      'provider.json',
      readback.providers.find((provider) => provider.id === 'role-eval'),
    )
    writer.write('isolation.json', {
      paths,
      config: overrides,
      approval:
        'on-request；自定义权限档位限定沙箱写入、禁止网络与状态目录读取；按次接受命令/文件审批，不使用全放权。',
    })
    return { ...paths, env, client, stop, model: `role-eval/${options.model}` }
  } catch (error) {
    await stop()
    throw error
  }
}
