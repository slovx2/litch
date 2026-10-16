#!/usr/bin/env node
// dsh 打样的隔离实例：工作区构建的 CLI、回环 mock 模型、独立的状态目录与端口，不读取个人配置与真实密钥。
//   --verify  经真实 SSH 用协议脚本走一遍线程列表、发消息、逐字流、提权审批，随后清理退出（不代表桌面 GUI 验收）
//   --gui     额外写入 ~/.ssh/config.d/cha-dsh-poc 供桌面端发现，常驻到 Ctrl-C，退出时删除片段与临时目录
// 前提：已执行 npm run build --prefix packages/dsh；dsh 本体不随适配器分发，用 CHA_DSH_CLI 指向本机已安装的 dsh
//（不设置时从 PATH 查找）。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { startMockModel } from '../packages/dsh/dist/dsh/test/mock-model.mjs'
import { MARK } from './dsh-poc-diagnostics.mjs'

const flags = new Set(process.argv.slice(2).filter((entry) => entry.startsWith('--')))
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const repo = resolve('.')
// 固定的短路径：桌面端登记的项目路径跨次运行不变，也避开 Unix socket 的长度上限。
const fixedRoot = option('--root', '/tmp/000-cha-dsh-poc')
const port = Number(option('--port', '7433'))
const alias = 'cha-dsh-poc'
// 实例的 PATH 是精简过的，这里先按调用者的环境定位 dsh，再以绝对路径交给实例。
const located = spawnSync('/bin/sh', ['-c', 'command -v "${CHA_DSH_CLI:-dsh}"'], {
  encoding: 'utf8',
})
const dshCli = located.stdout.trim()
assert.ok(dshCli, '找不到 dsh：请用 CHA_DSH_CLI 指向本机已安装的 dsh 可执行文件')
const fragment = join(homedir(), '.ssh', 'config.d', alias)
const active = []

// 场景按最近一条用户消息里的标记词选择；标记之后出现过几次工具结果决定走到第几步。
const plain = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
const pieces = (value, size) => value.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []
const escalated = (file) => ({
  type: 'tool_use',
  name: 'bash',
  input: {
    command: `echo DSH_POC_APPROVED > ${file}`,
    description: '写入验证文件',
    sandbox_permissions: 'danger-full-access',
    justification: '打样验证提权审批。',
  },
})
function respond(body) {
  const messages = body.messages ?? []
  let marker = null
  let at = messages.length
  for (let index = messages.length - 1; index >= 0 && !marker; index--) {
    if (messages[index].role !== 'user') continue
    marker = /DSH_POC_(CHAT|APPROVAL|DENY)/.exec(plain(messages[index].content))?.[0] ?? null
    at = index
  }
  const step = messages
    .slice(at + 1)
    .filter(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
    ).length
  // 不带工具的请求是 dsh 在生成标题：按场景给出可区分的标题，便于在桌面端的线程列表里辨认。
  if (!body.tools?.length) {
    const scene = /DSH_POC_(CHAT|APPROVAL|DENY)/.exec(JSON.stringify(messages))?.[1]
    return [{ type: 'text', chunks: [`dsh打样-${scene ?? 'ECHO'}`] }]
  }
  if (marker === 'DSH_POC_CHAT')
    return [
      { type: 'thinking', text: '用户在验证流式显示，逐字回答即可。' },
      {
        type: 'text',
        chunks: pieces(
          'DSH_POC_CHAT_OK 这是一段逐字到达的回复，用来确认桌面端的流式显示：' +
            '一二三四五六七八九十，甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉戌亥。DSH_POC_CHAT_DONE',
          2,
        ),
        delayMs: Number(option('--chunk-ms', '120')),
      },
    ]
  if (marker === 'DSH_POC_APPROVAL')
    return step
      ? [{ type: 'text', chunks: ['DSH_POC_APPROVAL_OK'] }]
      : [{ type: 'text', chunks: ['需要提权执行命令。'] }, escalated('dsh-poc-approved.txt')]
  if (marker === 'DSH_POC_DENY')
    return step
      ? [{ type: 'text', chunks: ['DSH_POC_DENY_OK'] }]
      : [{ type: 'text', chunks: ['需要提权执行命令。'] }, escalated('dsh-poc-denied.txt')]
  return [{ type: 'text', chunks: ['DSH_POC_ECHO_OK'] }]
}

async function startInstance() {
  await rm(fixedRoot, { recursive: true, force: true })
  await mkdir(fixedRoot, { recursive: true, mode: 0o700 })
  const root = await realpath(fixedRoot)
  // 目录名即桌面端显示的项目名，取一个不会与其他项目混淆的名字。
  const project = join(root, 'dsh-poc')
  for (const name of ['home', 'tmp', 'agents', 'dsh-poc'])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 })
  await writeFile(join(project, 'README.md'), 'dsh 打样验证项目\n')
  spawnSync('git', ['init', '--quiet', project])
  // dsh 的家目录（适配器状态目录下的 dsh/dsh-home）里的补丁层：挂上诊断插件，dsh 自己的告警和标题请求的去向进运行日志
  const dshHome = join(root, 'state', 'dsh', 'dsh-home')
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  const diagnostics = fileURLToPath(new URL('./dsh-poc-diagnostics.mjs', import.meta.url))
  await writeFile(
    join(dshHome, 'cordis.patch.yml'),
    `- insert:\n    - id: cha-dsh-poc-diagnostics\n      name: ${JSON.stringify(diagnostics)}\n`,
  )
  // 自带一份 CLI，避免占用或覆盖工作区里别人正在用的 bin/。
  const cli = join(root, 'codex-harness-adapter')
  const built = spawnSync('go', ['build', '-o', cli, './cmd/codex-harness-adapter'], {
    stdio: 'inherit',
  })
  assert.equal(built.status, 0, 'CLI 构建失败')
  const model = await startMockModel(respond)
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(root, 'home'),
    SHELL: '/bin/sh',
    TMPDIR: join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
    // 下面按中文提示等“SSH 就绪”，命令行的输出语言单独定成中文
    CHA_LANG: 'zh-CN',
    USER: 'dsh-poc',
    LOGNAME: 'dsh-poc',
    DEEPSEEK_BASE_URL: model.url,
    DEEPSEEK_API_KEY: 'mock-not-a-real-key',
    DSH_AGENTS_HOME: join(root, 'agents'),
    CHA_DSH_CLI: resolve(dshCli),
    CHA_DSH_TRACE: join(root, 'wire.jsonl'),
  }
  const args = ['--harness', 'dsh', '--home', join(root, 'state'), '--port', String(port)]
  args.push('--node', process.execPath, '--root', repo)
  for (const command of ['init', 'doctor']) {
    const result = spawnSync(cli, [command, ...args], { env, encoding: 'utf8', timeout: 60000 })
    assert.equal(result.status, 0, `${command} 失败: ${result.stderr}${result.stdout}`)
  }
  const printed = spawnSync(cli, ['ssh-config', ...args], { env, encoding: 'utf8' })
  assert.equal(printed.status, 0, printed.stderr)
  const sshConfig = `${printed.stdout.replace(/^Host .*$/m, `Host ${alias}`)}  ConnectTimeout 5\n`
  assert.match(sshConfig, new RegExp(`^Host ${alias}$`, 'm'))
  await writeFile(join(root, 'ssh_config'), sshConfig, { mode: 0o600 })
  // 整个实例放进只允许回环外连的沙箱：即便配置有误，也发不出真实的模型请求或其它外连。
  const loopbackOnly =
    '(version 1)(allow default)(deny network-outbound)' +
    '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))'
  const service = spawn('/usr/bin/sandbox-exec', ['-p', loopbackOnly, cli, 'serve', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  active.push(service)
  let output = ''
  service.stderr.on('data', (chunk) => {
    output += chunk
  })
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`SSH 启动超时: ${output}`)), 60000)
    service.once('exit', (code) => fail(new Error(`SSH 提前退出 ${code}: ${output}`)))
    service.stdout.on('data', (chunk) => {
      output += chunk
      if (!String(chunk).includes('SSH 就绪')) return
      clearTimeout(timer)
      done()
    })
  })
  return { root, project, model, env, sshConfig, service }
}

// 经真实 ssh 进入 `codex app-server proxy`，在其标准输入输出上跑 WebSocket。
async function connect(instance, approve) {
  const ssh = spawn(
    'ssh',
    [
      '-F',
      join(instance.root, 'ssh_config'),
      '-o',
      'BatchMode=yes',
      alias,
      'codex app-server proxy',
    ],
    { env: instance.env },
  )
  active.push(ssh)
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => Duplex.from({ readable: ssh.stdout, writable: ssh.stdin }),
  })
  await once(ws, 'open')
  let sequence = 0
  const pending = new Map()
  const notifications = []
  const requests = []
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.method && message.id !== undefined) {
      requests.push(message)
      ws.send(JSON.stringify({ id: message.id, result: approve(message) }))
    } else if (message.method) notifications.push({ ...message, at: Date.now() })
    else pending.get(message.id)?.(message)
  })
  return {
    notifications,
    requests,
    close: () => ssh.kill(),
    rpc(method, params = {}) {
      const id = ++sequence
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`${method} 超时`)), 30000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          pending.delete(id)
          if (message.error) fail(new Error(`${method}: ${JSON.stringify(message.error)}`))
          else done(message.result)
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    async until(method, match = () => true) {
      for (let waited = 0; waited < 60000; waited += 50) {
        const found = notifications.find((entry) => entry.method === method && match(entry.params))
        if (found) return found.params
        await new Promise((done) => setTimeout(done, 50))
      }
      throw new Error(`等待通知超时: ${method}`)
    },
  }
}

// dsh 的标题没落到线程上时看两头：模拟模型收到过几次这个线程的标题请求（不带工具的那种），
// dsh 自己的会话记录里有哪些标题事件（有请求、没有模型起的标题，是 dsh 那头作废了或失败了）。
async function titleTrail(instance, threadId) {
  const asked = instance.model.requests.filter(
    (body) => !body.tools?.length && JSON.stringify(body.messages).includes('DSH_POC_CHAT'),
  ).length
  const sessions = join(instance.root, 'state', 'dsh', 'dsh-home', 'sessions')
  const file = (await readdir(sessions, { recursive: true })).find((entry) =>
    entry.endsWith(`${threadId}/session.v4.jsonl.zstd`),
  )
  if (!file) return `标题请求 ${asked} 次，找不到 dsh 的会话记录`
  // 会话记录是一段段 zstd 帧接起来的，Node 只解第一帧，所以按帧头切开逐段解。
  // 帧头那四个字节也可能碰巧出现在压缩数据里：解不开的那段并上下一段再解
  const bytes = await readFile(join(sessions, file))
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const ends = []
  for (let at = bytes.indexOf(magic, 1); at >= 0; at = bytes.indexOf(magic, at + 1)) ends.push(at)
  ends.push(bytes.length)
  const lines = []
  let from = 0
  for (const end of ends) {
    try {
      lines.push(...zstdDecompressSync(bytes.subarray(from, end)).toString().split('\n'))
      from = end
    } catch {}
  }
  const events = lines
    .filter((line) => line.includes('"type":"session/title'))
    .map((line) => {
      const event = JSON.parse(line)
      return event.data?.source ? `${event.type}（${event.data.source.kind}）` : event.type
    })
  // 模拟模型这头的连接和请求，时刻从头一条算起；起点的绝对时刻和诊断行里的对得上
  const start = instance.model.events[0]?.at ?? 0
  const timeline = instance.model.events.map(
    (event) =>
      `  +${event.at - start}ms 连接${event.socket} ${event.kind}${event.detail ? ` ${event.detail}` : ''}`,
  )
  return [
    `标题请求 ${asked} 次，dsh 的标题事件：${events.join('、') || '没有'}`,
    'dsh 的诊断（告警和这个线程的标题请求）：',
    ...(await diagnosed(instance, threadId)).map((line) => `  ${line}`),
    `模拟模型的连接与请求（共 ${instance.model.requests.length} 个请求，+0 是 ${start}）：`,
    ...timeline,
  ].join('\n')
}

// 运行日志里诊断插件写的行：dsh 的告警，和这个线程的标题请求的去向
async function diagnosed(instance, threadId) {
  const log = await readFile(join(instance.root, 'state', 'dsh', 'runtime.log'), 'utf8').catch(
    () => '',
  )
  return log
    .split('\n')
    .filter((line) => line.startsWith(MARK))
    .filter((line) => line.includes(threadId) || / (warn|error) /.test(line))
}

async function verify(instance) {
  const { project } = instance
  const version = spawnSync(
    'ssh',
    ['-F', join(instance.root, 'ssh_config'), '-o', 'BatchMode=yes', alias, 'codex --version'],
    { env: instance.env, encoding: 'utf8', timeout: 15000 },
  )
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /codex-cli 0\.157\.1 \(codex-harness-adapter-dsh\)/)
  let decision = 'accept'
  const desktop = await connect(instance, () => ({ decision }))
  const init = await desktop.rpc('initialize', {
    clientInfo: { name: 'dsh-poc-verify', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  })
  assert.match(init.userAgent, /0\.157\.1/)
  // 桌面端连接后会并发发出一批请求，此时 dsh 子进程还在启动。
  const [models] = await Promise.all([
    desktop.rpc('model/list', {}),
    desktop.rpc('thread/list', { cwd: project }),
    desktop.rpc('config/read', { cwd: project }),
    desktop.rpc('account/read', {}),
    desktop.rpc('collaborationMode/list', {}),
    desktop.rpc('permissionProfile/list', { cwd: project }),
    desktop.rpc('skills/list', { cwds: [project] }),
  ])
  assert.ok(models.data.length > 0, '模型目录为空')
  const turn = async (threadId, text) => {
    const started = await desktop.rpc('turn/start', { threadId, input: [{ type: 'text', text }] })
    const done = await desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === started.turn.id,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    return done.turn
  }
  const start = async () =>
    (await desktop.rpc('thread/start', { cwd: project, sandbox: 'workspace-write' })).thread.id

  // 1. 发消息 + 逐字流：增量分多次、跨一段时间到达，拼起来等于落盘的正文。
  const first = await start()
  assert.deepEqual(
    (await desktop.rpc('thread/list', { cwd: project })).data,
    [],
    '空白会话不进列表',
  )
  // 桌面端新建线程时的顺序：另开一条临时线程跑标题回合 → 没有结果时把首条消息原文写回 → 首个回合。
  // 临时线程不进线程列表、不在 dsh 里建会话；写回的名字不钉住，标题最终来自 dsh 自己的生成。
  const helper = await desktop.rpc('thread/start', {
    cwd: project,
    ephemeral: true,
    model: 'gpt-6-luna',
    allowProviderModelFallback: true,
    approvalPolicy: 'never',
    permissions: ':read-only',
  })
  assert.equal(helper.thread.ephemeral, true, '临时线程的回包要带 ephemeral')
  await desktop.rpc('turn/start', {
    threadId: helper.thread.id,
    turnTrigger: 'thread_title',
    input: [{ type: 'text', text: '起一个标题。\n\nUser prompt:\n请开始 DSH_POC_CHAT' }],
    outputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
    },
  })
  const titleTurn = await desktop.until(
    'turn/completed',
    (params) => params.threadId === helper.thread.id,
  )
  assert.equal(titleTurn.turn.status, 'completed', '标题回合不应报错')
  assert.ok(!titleTurn.turn.items.some((item) => item.type === 'agentMessage'))
  await desktop.rpc('thread/unsubscribe', { threadId: helper.thread.id })
  await desktop.rpc('thread/name/set', { threadId: first, name: '请开始 DSH_POC_CHAT' })
  const chat = await turn(first, '请开始 DSH_POC_CHAT')
  const message = chat.items.find((item) => item.type === 'agentMessage')
  const deltas = desktop.notifications.filter(
    (entry) => entry.method === 'item/agentMessage/delta' && entry.params.itemId === message.id,
  )
  const span = deltas.at(-1).at - deltas[0].at
  assert.ok(deltas.length >= 20 && span >= 1000, `增量 ${deltas.length} 次、跨度 ${span} 毫秒`)
  assert.equal(deltas.map((entry) => entry.params.delta).join(''), message.text)
  assert.match(message.text, /^DSH_POC_CHAT_OK .*DSH_POC_CHAT_DONE$/)
  assert.ok(
    chat.items.some((item) => item.type === 'reasoning'),
    '缺少推理条目',
  )

  // 2. 提权审批：同一线程里批准，命令真实执行。
  const approved = await turn(first, '请执行 DSH_POC_APPROVAL')
  assert.equal(desktop.requests.length, 1)
  assert.equal(desktop.requests[0].method, 'item/commandExecution/requestApproval')
  assert.match(desktop.requests[0].params.command, /dsh-poc-approved\.txt/)
  const command = approved.items.find((item) => item.type === 'commandExecution')
  assert.equal(command.status, 'completed')
  assert.equal(await readFile(join(project, 'dsh-poc-approved.txt'), 'utf8'), 'DSH_POC_APPROVED\n')
  assert.equal(approved.items.at(-1).text, 'DSH_POC_APPROVAL_OK')

  // 3. 拒绝：命令不执行，模型收到拒绝后继续。
  decision = 'decline'
  const second = await start()
  const denied = await turn(second, '请执行 DSH_POC_DENY')
  assert.equal(desktop.requests.length, 2)
  assert.ok(!existsSync(join(project, 'dsh-poc-denied.txt')), '拒绝后命令仍被执行')
  assert.equal(denied.items.find((item) => item.type === 'commandExecution').status, 'declined')
  assert.equal(denied.items.at(-1).text, 'DSH_POC_DENY_OK')
  // dsh 的标题是在第一个回合旁边另发一个模型请求生成的，不等回合，到这里一般早就到了。
  // 等一会儿还没到，就把两头看到的写进失败信息，分得清是 dsh 没生成出来还是适配器没接上
  const titled = () =>
    desktop.notifications.some(
      (entry) =>
        entry.method === 'thread/name/updated' &&
        entry.params.threadId === first &&
        entry.params.threadName === 'dsh打样-CHAT',
    )
  for (let waited = 0; waited < 10000 && !titled(); waited += 50)
    await new Promise((done) => setTimeout(done, 50))
  if (!titled()) {
    const missing = (await titleTrail(instance, first)).split('\n', 1)[0]
    // 再等 dsh 给这次标题请求一个结局（结束、出错、被取消），最多等过它自己的 60 秒时限，
    // 分得清是卡住了还是早就失败了。等到了也照样算失败
    const settled = async () =>
      (await diagnosed(instance, first)).some((line) =>
        / title (ended|threw|closed early|aborted) |automatic title generation failed/.test(line),
      )
    const since = Date.now()
    while (Date.now() - since < 65000 && !titled() && !(await settled()))
      await new Promise((done) => setTimeout(done, 500))
    assert.fail(
      `第一个线程没收到 dsh 起的标题：${missing}\n` +
        `又等了 ${Math.round((Date.now() - since) / 1000)} 秒，${titled() ? '标题到了' : '仍然没有标题'}：` +
        (await titleTrail(instance, first)),
    )
  }
  desktop.close()

  // 4. 线程列表与历史：另开一条连接，两个线程都在，历史条目与实时一致。
  const other = await connect(instance, () => ({ decision: 'decline' }))
  await other.rpc('initialize', { clientInfo: { name: 'dsh-poc-verify', version: '0.0.0' } })
  const listed = await other.rpc('thread/list', { cwd: project })
  assert.deepEqual(listed.data.map((thread) => thread.id).sort(), [first, second].sort())
  const chatThread = listed.data.find((thread) => thread.id === first)
  assert.match(chatThread.preview, /DSH_POC_CHAT/)
  assert.equal(chatThread.name, 'dsh打样-CHAT', '线程标题来自 dsh 的标题生成')
  const stored = await readdir(join(instance.root, 'state', 'dsh', 'dsh-home', 'sessions'), {
    recursive: true,
  })
  assert.equal(
    stored.filter((entry) => /(^|\/)session-[0-9a-f-]{36}$/.test(entry)).length,
    2,
    'dsh 的会话存储里只有两条真实线程，没有标题线程留下的空会话',
  )
  const lean = await other.rpc('thread/resume', { threadId: first, excludeTurns: true })
  assert.deepEqual(lean.thread.turns, [], 'excludeTurns 时不带回合')
  const resumed = await other.rpc('thread/resume', { threadId: first })
  assert.deepEqual(
    resumed.thread.turns.flatMap((entry) => entry.items.map((item) => item.id)),
    [...chat.items, ...approved.items].map((item) => item.id),
  )
  const replayed = await other.rpc('thread/read', { threadId: second, includeTurns: true })
  assert.equal(
    replayed.thread.turns[0].items.find((item) => item.type === 'commandExecution').status,
    'declined',
    '另一条连接读到的被拒绝命令仍是 declined',
  )
  other.close()
  assert.ok(
    instance.model.requests.every((request) => !('dsh_session_log' in request)),
    '会话日志不应上传',
  )
  console.log(
    `[dsh-poc] 协议级验证通过：线程 ${listed.data.length} 个，增量 ${deltas.length} 次（跨 ${span} 毫秒），` +
      `审批请求 ${desktop.requests.length} 次，模型请求 ${instance.model.requests.length} 次（全部回环）`,
  )
  // 过了也把诊断里出过的错亮出来：dsh 的主请求出错会自己重试，测试照样过，只有标题请求出错（不重试）才会挂
  const troubles = (await diagnosed(instance, '')).filter(
    (line) =>
      / (fetch failed|fetch headers unreadable|adapter request threw|adapter not watched) /.test(
        line,
      ) ||
      (/ (warn|error) /.test(line) && !line.includes('weaker process-tree containment')),
  )
  if (troubles.length) console.log(`[dsh-poc] dsh 的诊断里有这些：\n${troubles.join('\n')}`)
  // 第一个线程的标题请求各步的时刻，攒着和出事那次比
  const steps = (await diagnosed(instance, first)).filter(
    (line) =>
      / title (requested|ended) /.test(line) ||
      (/ fetch( answered)? /.test(line) && line.includes('不带工具')),
  )
  console.log(`[dsh-poc] 第一个线程的标题请求：\n${steps.join('\n')}`)
}

async function cleanup(instance) {
  await rm(fragment, { force: true })
  for (const child of active) if (child.exitCode === null) child.kill('SIGINT')
  if (instance) {
    if (instance.service.exitCode === null)
      await Promise.race([
        once(instance.service, 'exit'),
        new Promise((done) => setTimeout(done, 15000)),
      ])
    await instance.model.close()
    // 按唯一根目录回收可能残留的子进程，再删除目录。
    spawnSync('pkill', ['-KILL', '-f', instance.root])
  }
  await rm(fixedRoot, { recursive: true, force: true })
}

let instance
let failure
try {
  instance = await startInstance()
  if (flags.has('--verify')) await verify(instance)
  if (flags.has('--gui')) {
    await mkdir(dirname(fragment), { recursive: true, mode: 0o700 })
    await writeFile(
      fragment,
      `# 由 scripts/dsh-poc-serve.mjs 生成，退出时删除；仅指向本机 dsh 打样实例。\n${instance.sshConfig}`,
      { mode: 0o600 },
    )
    console.log(
      `[dsh-poc] ready ${JSON.stringify({ host: alias, port, project: instance.project, root: instance.root })}`,
    )
    await new Promise((done) => {
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, done)
    })
  }
} catch (error) {
  failure = error
}
await cleanup(instance)
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
