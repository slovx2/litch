// 手动真模型 CU 实测，默认不进 CI。需要 Node 24、支持命名空间动态工具的 Codex、已授权的独立助手。
// 用法见 README.md；--execute 才复制认证并调用真模型，--preflight 只查独立助手权限。
// 只开放 cases.json 的四个应用，文件只用专属 /tmp/litch-cu-trial；不启动 Litch UI 或连接其状态目录。
// finally 终止本次 Codex/助手和新启动的应用，删除认证副本与测试目录；完整记录仅存 --out。
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { prepareEnvironment } from './environment.mjs'
import { startCodex } from './rpc.mjs'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.endsWith('.mjs')) throw error
      return next(specifier.replace(/\.mjs$/, '.mts'), context)
    }
  },
})
const { createComputerExecutor } = await import('../../apps/desktop/src/computer-use/executor.mts')
const { MacLauncher } = await import('../../apps/desktop/src/computer-use/launcher-mac.mts')
const { HelperSupervisor } = await import('../../apps/desktop/src/computer-use/supervisor.mts')
const { computerToolsSpec } = await import('../../packages/protocol/src/client-tools-computer.mts')
const option = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const preflight = process.argv.includes('--preflight')
if (!preflight && !process.argv.includes('--execute'))
  throw new Error('请明确选择 --preflight 或 --execute')
const helperPath = option('--helper'),
  outPath = option('--out')
if (!helperPath || !outPath)
  throw new Error('需要 --helper 和 --out，必须指向独立测试助手及忽略的记录目录')
if (!helperPath.includes('/.artifacts/'))
  throw new Error('助手必须是 .artifacts 下单独构建的测试应用')
const out = resolve(outPath)
if (existsSync(out)) throw new Error('记录目录已存在，请换一个新目录，避免覆盖证据')
mkdirSync(out, { recursive: true, mode: 0o700 })
const cases = JSON.parse(
  readFileSync(
    option('--cases') ?? join(dirname(fileURLToPath(import.meta.url)), 'cases.json'),
    'utf8',
  ),
)
if (cases.directory !== '/tmp/litch-cu-trial') throw new Error('测试仅允许 /tmp/litch-cu-trial')
const root = mkdtempSync('/tmp/litch-cu-model-')
const allowed = new Set(cases.allowedApps)
const opened = new Set()
let ownsDirectory = false,
  rpc,
  threadId,
  task = 'preflight',
  imageSeq = 0,
  toolCount = 0
const controller = new AbortController()
const record = (file, value) => {
  const data = JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item
    const image = /^data:image\/(jpeg|png);base64,(.+)$/s.exec(item)
    if (!image) return item
    const name = `image-${++imageSeq}.${image[1]}`
    writeFileSync(join(out, name), Buffer.from(image[2], 'base64'))
    return `[${name}]`
  })
  appendFileSync(join(out, file), `${data}\n`, { mode: 0o600 })
}
const launcher = new MacLauncher({
  appPath: resolve(helperPath),
  directory: join(root, 'helper'),
  version: null,
  async launch(path, env) {
    mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 })
    execFileSync('open', [
      '-n',
      '-g',
      ...Object.entries({
        ...env,
        HOME: join(root, 'home'),
        CODEX_HOME: join(root, 'codex'),
      }).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      path,
    ])
  },
})
const helper = new HelperSupervisor({
  launcher,
  lang: () => 'zh-CN',
  log: (line) => record('helper.jsonl', { line }),
})
const executor = createComputerExecutor({ helper })
let activeTurn
let blockedReason
// list_apps 只列已有窗口的进程，应用刚启动还没有窗口时不能据此判断其是否原本在运行。
function targetProcesses() {
  return execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      return match && cases.processNames.includes(basename(match[2]))
        ? [{ pid: Number(match[1]), executable: match[2] }]
        : []
    })
}
async function invoke(message) {
  if (message.method !== 'item/tool/call') throw new Error(`实测不处理 ${message.method}`)
  const p = message.params
  const start = Date.now()
  let result
  if (++toolCount > 160 || p.namespace !== 'litch_computer') {
    result = {
      success: false,
      contentItems: [{ type: 'inputText', text: 'Trial scope exceeded.' }],
    }
  } else if (p.tool !== 'list_apps' && !allowed.has(p.arguments?.app)) {
    result = {
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: 'Trial only permits the four specified apps; use their bundle identifiers.',
        },
      ],
    }
  } else {
    result = await executor.call(
      {
        ...p,
        id: String(message.id),
        device: { id: 'trial', name: 'Trial', kind: 'local', target: null },
        harness: 'codex',
        cwd: root,
      },
      { signal: controller.signal, ask: async () => null },
    )
  }
  record('calls.jsonl', {
    task,
    at: new Date(start).toISOString(),
    durationMs: Date.now() - start,
    tool: p.tool,
    arguments: p.arguments,
    result,
  })
  if (!result.success) {
    const text = result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
    if (
      /macOS login or permission dialog|macOS denied or stopped screen capture|does not have macOS permission|Trial scope exceeded/.test(
        text,
      )
    )
      blockedReason = text
  }
  console.log(`${task}: ${p.tool} ${Date.now() - start} ms ${result.success ? 'ok' : 'failed'}`)
  return result
}
try {
  const client = await helper.client()
  const permissions = await client.request('permissions')
  record('preflight.jsonl', { permissions, hello: client.hello })
  console.log(JSON.stringify({ permissions }))
  if (!permissions.accessibility || !permissions.screenRecording)
    throw new Error('独立测试助手缺少系统权限；请用户授权，不能使用正式助手绕过')
  if (!preflight) {
    const executable = option('--codex'),
      source = option('--auth-source')
    if (!executable || !source) throw new Error('--execute 需要 --codex 和 --auth-source')
    if (existsSync(cases.directory)) throw new Error('测试目录已存在，不接管或删除其中的数据')
    mkdirSync(cases.directory, { mode: 0o700 })
    ownsDirectory = true
    const env = prepareEnvironment(root, resolve(source), cases.model)
    const before = targetProcesses()
    for (const app of allowed) {
      if (app === 'com.apple.finder') continue
      execFileSync('open', ['-g', '-b', app])
    }
    // 只终止运行器启动前没有在运行的应用进程。
    await delay(500)
    const after = targetProcesses()
    for (const app of after) if (!before.some((old) => old.pid === app.pid)) opened.add(app.pid)
    record('launched.jsonl', { before, after, ownedPids: [...opened] })
    const spec = computerToolsSpec('darwin')
    record('spec.jsonl', spec)
    rpc = startCodex(
      executable,
      env,
      root,
      (message) => record('events.jsonl', { at: new Date().toISOString(), message }),
      invoke,
    )
    await rpc.call('initialize', {
      clientInfo: { name: 'litch-cu-trial', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized')
    const thread = await rpc.call('thread/start', {
      cwd: root,
      model: cases.model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: cases.instructions,
      dynamicTools: [spec],
      ephemeral: true,
    })
    threadId = thread.thread.id
    for (const item of [...cases.tasks, { id: 'cleanup', prompt: cases.cleanup }]) {
      task = item.id
      const started = Date.now()
      const turn = await rpc.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: item.prompt.replaceAll('{{directory}}', cases.directory) }],
      })
      activeTurn = turn.turn.id
      const done = await rpc.wait(
        (event) => event.method === 'turn/completed' && event.params.turn.id === activeTurn,
      )
      executor.turnEnded({ deviceId: 'trial', threadId, turnId: activeTurn })
      record('turns.jsonl', { task, durationMs: Date.now() - started, turn: done.params.turn })
      activeTurn = undefined
      if (done.params.turn.status !== 'completed') throw new Error(`${task} 回合未完成`)
      if (blockedReason) {
        record('blocked.jsonl', { task, reason: blockedReason })
        break
      }
    }
    const { statSync } = await import('node:fs')
    const note = join(cases.directory, '已整理/cu-note.rtf')
    record('verification.jsonl', {
      movedFileExists: existsSync(note),
      bytes: existsSync(note) ? statSync(note).size : 0,
    })
  }
} finally {
  controller.abort()
  if (activeTurn && threadId)
    executor.turnEnded({ deviceId: 'trial', threadId, turnId: activeTurn })
  await rpc?.stop()
  await helper.dispose()
  for (const pid of opened) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  if (ownsDirectory) rmSync('/tmp/litch-cu-trial', { recursive: true, force: true })
  // root 是本进程 mkdtemp 创建的字面前缀目录，不接受外部输入。
  rmSync(root, { recursive: true, force: true })
}
