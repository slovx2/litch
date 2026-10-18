// 对着这台机器上真的 codex 检查“原生 codex 接进聚合面”：
// 真的适配器主进程（Go，现编到临时目录里）+ 真的设备进程 + PATH 里的 codex，客户端只连聚合面，
// 在设置里把 Codex 打开，看它的声明，新建会话跑一个回合，再跑要审批的回合（命令的、文件改动的各一个），最后关掉。
// CI 上没有 codex，自动化测试用的是假的 codex（packages/device/test/service-codex.test.mts）；这一条在本机跑。
//
// 用法：node scripts/check-native-codex.mjs（先 npm run build --prefix packages/device；需要本机有 go）
//   CHA_CODEX_CLI 指定用哪一份 codex；没给时用 PATH 里的，PATH 里也没有就说明原因后跳过（退出码 0）。
//
// 隔离（都在一个短名字的临时目录里，跑完删掉）：
// - 不碰用户真实的 codex 数据目录（~/.codex）和他正在运行的 codex 服务：HOME、CODEX_HOME 都指到临时目录，
//   主进程和它起的 codex 用的是一份从零写的干净环境，不继承这个进程的环境变量；
// - 不用任何账号和密钥：模型是回环地址上的一个假的 Responses 接口，照 codex 自定义模型提供方的配置接进去；
//   代理变量指到回环上一个没人听的端口，回环之外的请求一律连不出去；
// - 只用 PATH 里的 codex，装在 /Applications 下的（官方桌面端自带的那一份）不用；
// - 不连真实的适配器状态目录（~/.codex-harness-adapter）；Claude Code 和 Pi 的命令行指到不存在的路径，不会被拿去跑；
// - 结束时按进程号收掉自己起的进程，删掉临时目录和 codex 在 /tmp/codex-daemon-<uid>/ 下给这个套接字留的文件。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import {
  codexConfig,
  codexSocketCleanup,
  findCodex,
  startResponsesModel,
  userText,
} from './client-fixture-responses.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

let codex = null
try {
  codex = findCodex()
} catch (error) {
  // 给了 CHA_CODEX_CLI 却用不了：直接失败，不跳过
  console.error(error.message)
  process.exit(1)
}
if (!codex) {
  console.log(
    '跳过：PATH 里没有 codex 命令行（官方桌面端自带的那一份不算），这一条检查要它才能跑。',
  )
  process.exit(0)
}
if (process.platform === 'win32') {
  console.log('跳过：Windows 上还不能把原生 Codex 接进来。')
  process.exit(0)
}
const deviceMain = join(repo, 'packages/device/dist/device/src/main.mjs')
if (!existsSync(deviceMain)) {
  console.error('没有找到设备进程的构建产物，请先运行 npm run build --prefix packages/device')
  process.exit(1)
}

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync('/tmp/lcx-')
const dirs = {
  userHome: join(root, 'h'),
  codexHome: join(root, 'c'),
  tmp: join(root, 't'),
  adapterHome: join(root, 'a'),
  work: join(root, 'w'),
}
for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true })
const runtimeSocket = join(dirs.adapterHome, 'codex', 'runtime.sock')
const deviceSocket = join(dirs.adapterHome, 'device', 'device.sock')

// ---------- 假模型：回环上的 Responses 接口 ----------
// 把收到的话带回来；话里带“跑命令”时先让 codex 跑一条往工作目录里写文件的命令（会触发审批）；
// 带“改文件”时让它打一个新增文件的补丁：这个模型名字它不认识，不给 apply_patch 工具，
// 补丁经命令工具用 heredoc 递进去，codex 会认出来、按文件改动处理。
const PROBE_FILE = 'approval-probe.txt'
const PATCH_FILE = 'patch-probe.txt'
const PATCH_COMMAND = [
  "apply_patch <<'PATCH'",
  '*** Begin Patch',
  `*** Add File: ${PATCH_FILE}`,
  '+probe',
  '*** End Patch',
  'PATCH',
].join('\n')
const model = await startResponsesModel((body) => {
  const input = Array.isArray(body.input) ? body.input : []
  const tools = (body.tools ?? []).map((tool) => tool.name ?? tool.type)
  const said = userText(body)
  const afterTool = input.at(-1)?.type === 'function_call_output'
  const command = afterTool
    ? null
    : said.includes('改文件')
      ? PATCH_COMMAND
      : said.includes('跑命令')
        ? `echo probe > ${PROBE_FILE}`
        : null
  if (!command) return { text: afterTool ? `命令跑完了。收到：${said}` : `假模型收到：${said}` }
  return {
    call: tools.includes('exec_command')
      ? { name: 'exec_command', arguments: JSON.stringify({ cmd: command }) }
      : tools.includes('shell_command')
        ? { name: 'shell_command', arguments: JSON.stringify({ command }) }
        : { name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }) },
  }
})
writeFileSync(join(dirs.codexHome, 'config.toml'), codexConfig(model.baseUrl))

/** 主进程（和它起的 codex）用的环境：从零写的，不继承这个进程的任何变量 */
const DEAD_PROXY = 'http://127.0.0.1:9'
const isolated = {
  HOME: dirs.userHome,
  CODEX_HOME: dirs.codexHome,
  TMPDIR: dirs.tmp,
  // 只有 node 和系统目录：codex 的路径在设置里写明，别的命令行（claude、dsh……）一概找不到
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  all_proxy: DEAD_PROXY,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  CHA_LANG: 'zh-CN',
  CHA_CLAUDE_CLI: join(root, 'no-claude'),
  PI_CLI: join(root, 'no-pi'),
}

// ---------- 聚合面上的客户端 ----------
async function connect(path) {
  const ws = new WebSocket(`ws+unix://${path}:/`)
  await new Promise((done, fail) => {
    ws.once('open', done)
    ws.once('error', fail)
  })
  const pending = new Map()
  const incoming = []
  const waiters = new Set()
  let nextId = 1
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    if (typeof frame.method !== 'string') {
      const entry = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) entry?.fail(Object.assign(new Error(frame.error.message), frame.error))
      else entry?.done(frame.result)
      return
    }
    incoming.push(frame)
    for (const waiter of [...waiters]) if (waiter(frame)) waiters.delete(waiter)
  })
  return {
    incoming,
    call(method, params) {
      const id = nextId++
      return new Promise((done, fail) => {
        pending.set(id, { done, fail })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    answer: (id, result) => ws.send(JSON.stringify({ id, result })),
    /** 等一帧对面主动发来的（通知或请求）。from：只看这个位置之后收到的 */
    waitFor(what, predicate, from = 0, timeoutMs = 60_000) {
      const seen = incoming.slice(from).find(predicate)
      if (seen) return Promise.resolve(seen)
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          fail(new Error(`等了 ${timeoutMs / 1000} 秒没有等到：${what}`))
        }, timeoutMs)
        const waiter = (frame) => {
          if (incoming.indexOf(frame) < from || !predicate(frame)) return false
          clearTimeout(timer)
          done(frame)
          return true
        }
        waiters.add(waiter)
      })
    },
    close: () => ws.close(),
  }
}

// ---------- 起真的主进程 ----------
const binary = join(root, 'cha')
const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
  cwd: repo,
  encoding: 'utf8',
})
let service = null
let output = ''
/** 删掉 codex 给这个套接字在 /tmp/codex-daemon-<uid>/ 下建的实际文件（codex 起来之后才认得出） */
let removeCodexSocket = () => {}

function stopService() {
  const child = service
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    // 主进程要先把它管着的 codex 和设备进程收掉，多等它一会儿
    const force = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.once('exit', () => {
      clearTimeout(force)
      done()
    })
    child.kill('SIGTERM')
  })
}

/** 命令行里带着这个临时目录的进程：都是这次检查起的（codex 的 app-server、设备进程、主进程） */
function leftovers() {
  const found = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' })
  return found.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

async function cleanup() {
  await stopService()
  model.close()
  const left = leftovers()
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出了
    }
  }
  removeCodexSocket()
  rmSync(root, { recursive: true, force: true })
  return left
}

// ---------- 检查 ----------
const STATUS = 'litch/harness/status/changed'
const WRITE = 'litch/device/settings/write'
const expect = (condition, what) => {
  if (!condition) throw new Error(`不符合预期：${what}`)
}
const passed = (line) => console.log(`✔ ${line}`)
const codexStatus = (kind) => (frame) =>
  frame.method === STATUS &&
  frame.params.harness === 'codex' &&
  (frame.params.info.unavailable?.kind ?? null) === kind
const text = (value) => [{ type: 'text', text: value, text_elements: [] }]
/** 标准协议里文件改动审批能答的全部决定，设备进程补的就是这一份（protocol/extensions/decline-with-note.json） */
const FILE_CHANGE_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel']

/** 用 node 跑一个脚本，等它退出。不能同步地等：假模型就在这个进程里，要接着应答 */
function run(args, env, timeoutMs = 120_000) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

async function main() {
  if (built.status !== 0)
    throw new Error(`适配器主进程没有编出来（需要本机有 go）：${built.stderr || built.error}`)
  service = spawn(
    binary,
    ['start', '--home', dirs.adapterHome, '--root', repo, '--node', process.execPath, '--ssh=off'],
    { env: isolated, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const stream of [service.stdout, service.stderr])
    stream.on('data', (data) => {
      output += data
    })
  for (let attempt = 0; !existsSync(deviceSocket); attempt++) {
    if (service.exitCode !== null) throw new Error('适配器主进程提前退出了')
    if (attempt > 600) throw new Error('等了 60 秒，聚合面的套接字还没有出现')
    await pause(100)
  }
  const client = await connect(deviceSocket)
  await client.call('initialize', {
    clientInfo: { name: 'litch-check', title: null, version: '0.0.1' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      litchExtensions: ['harness', 'deviceSettings', 'declineWithNote'],
    },
  })
  const codexInfo = async () =>
    (await client.call('runtime/info')).harnesses.find((item) => item.id === 'codex')

  const before = await codexInfo()
  // 主进程的 PATH 里没有 codex：装了才默认启用，所以这时报的是没装
  expect(
    before?.unavailable?.kind === 'notInstalled',
    `主进程的 PATH 里没有 codex，应报没装，实际 ${JSON.stringify(before)}`,
  )
  passed(`没写过设置、PATH 里找不到时不启用：${before.unavailable.message}`)

  // 在设置里打开，命令行路径写明是 PATH 里找到的那个
  let version = (await client.call('litch/device/settings/read')).snapshot.version
  const write = async (edits) => {
    const written = await client.call(WRITE, { expectedVersion: version, edits })
    version = written.snapshot.version
    // 判断不了有没有回合在跑的时候它会留着待重启：这里是检查，直接照做
    if (!written.restarted.includes('codex'))
      await client.call('litch/device/harness/restart', { harness: 'codex', force: true })
  }
  let mark = client.incoming.length
  await write([
    { key: 'harness.codex.enabled', value: true },
    { key: 'harness.codex.cliPath', value: codex },
  ])
  await client.waitFor(
    'Codex 变成可用',
    (frame) => codexStatus(null)(frame) && frame.params.info.available === true,
    mark,
  )
  const info = await codexInfo()
  expect(info.available && info.engine === 'codex', `应该可用：${JSON.stringify(info.unavailable)}`)
  expect(/^\d+\.\d+\.\d+/.test(info.version ?? ''), `版本没有认出来：${info.version}`)
  expect(info.features && info.permissionPresets?.length > 0, '声明里应有能力位和权限预设')
  // 它不认识我们的扩展；只有客户端工具是设备进程替它挑执行方，所以报这一项
  expect(
    JSON.stringify(info.extensions) === JSON.stringify(['clientTools']),
    `扩展只应有设备进程替它做的 clientTools：${JSON.stringify(info.extensions)}`,
  )
  passed(
    `启用后可用：${info.displayName} ${info.version}（${codex}），权限预设 ${info.permissionPresets.map((preset) => preset.id).join('、')}`,
  )
  removeCodexSocket = codexSocketCleanup(runtimeSocket)

  // 新建会话，跑一个回合。选了“工作区”这一档，设备进程替它配上 on-request
  const started = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':workspace',
  })
  expect(started.thread.harness === 'codex', '新建的会话应标着 harness')
  expect(
    started.approvalPolicy === 'on-request',
    `审批策略应是 on-request：${started.approvalPolicy}`,
  )
  expect(
    started.activePermissionProfile?.id === ':workspace',
    `权限档应是 :workspace：${JSON.stringify(started.activePermissionProfile)}`,
  )
  mark = client.incoming.length
  const threadId = started.thread.id
  await client.call('turn/start', { threadId, input: text('你好，原生 codex') })
  const done = await client.waitFor(
    '回合结束',
    (frame) => frame.method === 'turn/completed' && frame.params.threadId === threadId,
    mark,
  )
  expect(
    done.params.turn.status === 'completed',
    `回合没有正常结束：${JSON.stringify(done.params.turn)}`,
  )
  const messages = client.incoming
    .slice(mark)
    .filter((frame) => frame.params?.item?.type === 'agentMessage')
  const reply = messages.find((frame) => frame.method === 'item/completed')?.params.item
  expect(reply?.text === '假模型收到：你好，原生 codex', `回话不对：${JSON.stringify(reply)}`)
  const opening = messages.find((frame) => frame.method === 'item/started')?.params.item
  expect(opening?.phase === 'final_answer', `消息开始时就该带着阶段值：${JSON.stringify(opening)}`)
  passed(`新建会话并跑完一个回合：${reply.text}`)

  const open = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':danger-full-access',
  })
  expect(open.approvalPolicy === 'never', `完全访问应配 never：${open.approvalPolicy}`)
  passed('权限预设到底层设置的映射：工作区配 on-request，完全访问配 never')

  // 审批往返：审批策略给 untrusted，假模型让它跑一条写文件的命令
  const careful = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':workspace',
    approvalPolicy: 'untrusted',
  })
  mark = client.incoming.length
  await client.call('turn/start', { threadId: careful.thread.id, input: text('请跑命令') })
  const asked = await client.waitFor(
    '命令审批，或者回合没有问就结束了',
    (frame) =>
      frame.method === 'item/commandExecution/requestApproval' ||
      (frame.method === 'turn/completed' && frame.params.threadId === careful.thread.id),
    mark,
  )
  expect(asked.method !== 'turn/completed', '回合没有来问审批就结束了')
  const decisions = asked.params.availableDecisions
  expect(
    Array.isArray(decisions) && decisions.includes('accept'),
    `决定列表不对：${JSON.stringify(decisions)}`,
  )
  client.answer(asked.id, { decision: 'accept' })
  const finished = await client.waitFor(
    '审批之后回合结束',
    (frame) => frame.method === 'turn/completed' && frame.params.threadId === careful.thread.id,
    mark,
  )
  expect(finished.params.turn.status === 'completed', '审批之后回合没有正常结束')
  expect(existsSync(join(dirs.work, PROBE_FILE)), '批准之后命令应该跑了')
  await client.waitFor(
    '审批有结果的通知',
    (frame) => frame.method === 'serverRequest/resolved',
    mark,
  )
  passed(
    `审批往返：请求号 ${JSON.stringify(asked.id)}，它自己给的决定列表 ${JSON.stringify(decisions)}，批准后命令跑了`,
  )

  // 文件改动的审批：只读这一档（设备进程配上 on-request），假模型让它打一个新增文件的补丁。
  // 标准协议里这种审批不带决定列表；这条连接声明了 declineWithNote，设备进程替它补上固定的四种。
  // 这一版的 codex 要是不把它当文件改动来问，这一步说明后跳过，不算失败（自动化测试里有假 codex 的那一份）。
  const guarded = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':read-only',
  })
  const ofGuarded = (frame) => frame.params?.threadId === guarded.thread.id
  mark = client.incoming.length
  await client.call('turn/start', { threadId: guarded.thread.id, input: text('请改文件') })
  const patchAsked = await client.waitFor(
    '文件改动审批，或者回合没有问就结束了',
    (frame) =>
      ofGuarded(frame) &&
      (frame.method === 'item/fileChange/requestApproval' ||
        frame.method === 'item/commandExecution/requestApproval' ||
        frame.method === 'turn/completed'),
    mark,
  )
  if (patchAsked.method === 'item/fileChange/requestApproval') {
    const supplied = patchAsked.params.availableDecisions
    expect(
      JSON.stringify(supplied) === JSON.stringify(FILE_CHANGE_DECISIONS),
      `文件改动审批的决定列表应是补上的固定四种：${JSON.stringify(supplied)}`,
    )
    client.answer(patchAsked.id, { decision: 'accept' })
    const patched = await client.waitFor(
      '批准之后回合结束',
      (frame) => frame.method === 'turn/completed' && ofGuarded(frame),
      mark,
    )
    expect(patched.params.turn.status === 'completed', '批准补丁之后回合没有正常结束')
    expect(existsSync(join(dirs.work, PATCH_FILE)), '批准之后补丁应该打上了')
    passed(
      `文件改动审批：它不带决定列表，设备进程补的是 ${JSON.stringify(supplied)}，批准后文件写出来了`,
    )
  } else {
    if (patchAsked.method !== 'turn/completed') {
      client.answer(patchAsked.id, { decision: 'cancel' })
      await client.waitFor(
        '取消之后回合结束',
        (frame) => frame.method === 'turn/completed' && ofGuarded(frame),
        mark,
      )
    }
    console.log(
      `－ 文件改动审批这一步没有验到：这一版的 codex 没有来问文件改动（来的是 ${patchAsked.method}）`,
    )
  }

  const list = await client.call('thread/list', { limit: 20 })
  expect(
    list.data.length >= 2 && list.data.every((thread) => thread.harness === 'codex'),
    `会话列表不对：${JSON.stringify(list.data.map((thread) => [thread.id, thread.harness]))}`,
  )
  // 这一次没列的里面不该有 codex。别的 harness 在这台设备上停用着或者没装的话会在里面，那是如实说明
  expect(
    list.skippedHarnesses.every((entry) => entry.harness !== 'codex'),
    `codex 的会话没有列出来：${JSON.stringify(list.skippedHarnesses)}`,
  )
  passed(`会话列表里有它的 ${list.data.length} 个会话，都标着 harness`)

  const unsupported = await client
    .call('thread/rollback', { threadId, numTurns: 1 })
    .catch((error) => error)
  expect(
    unsupported.code === -32601 &&
      unsupported.data?.litch === 'unsupported' &&
      unsupported.data.harness === 'codex',
    `不认识的方法应报“不支持”：${JSON.stringify([unsupported.code, unsupported.message, unsupported.data])}`,
  )
  const invalid = await client
    .call('turn/start', { threadId, input: '不是数组' })
    .catch((error) => error)
  expect(
    invalid.code === -32600 && invalid.data === undefined,
    `参数不对应是它的原话：${JSON.stringify([invalid.code, invalid.message, invalid.data])}`,
  )
  passed(`不支持和别的错误分得开：${unsupported.message}｜${invalid.message.slice(0, 80)}`)

  // 客户端核心也走一遍：借用客户端的自检小工具（只用，不改它），让它直接连这个聚合面，
  // 用客户端自己的连接层握手、在 codex 上新建会话、跑一个回合
  const tool = join(repo, 'apps/desktop/dist/adapter-check.mjs')
  if (existsSync(tool)) {
    const sentence = '客户端核心发的一句话'
    const ran = await run(
      [tool, '--info', '--turn', 'codex', '--say', sentence, '--cwd', dirs.work],
      { ...isolated, SHELL: '/bin/sh', LITCH_ENTRY: deviceSocket, LITCH_LANG: 'zh-CN' },
    )
    const lines = ran.stdout.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    const result = lines.find((line) => line.result)
    const turn = lines.find((line) => line.turn)?.turn
    const seen = lines.find((line) => line.info)?.info.harnesses.find((item) => item.id === 'codex')
    expect(
      ran.code === 0 && result?.result === 'ok',
      `客户端的自检小工具没有连上：${ran.stdout}\n${ran.stderr}`,
    )
    expect(seen?.available === true, `客户端看到的 Codex 应该可用：${JSON.stringify(seen)}`)
    expect(
      turn?.status === 'completed' && turn.echoed === true,
      `客户端核心跑的回合不对：${JSON.stringify(turn)}`,
    )
    passed(`客户端核心（adapter-check）在 codex 上新建会话并跑完一个回合：${turn.reply}`)
  } else
    console.log(
      '－ 跳过客户端核心那一遍：没有 apps/desktop/dist/adapter-check.mjs（npm run build --prefix apps/desktop 之后才有）',
    )

  // 首次导入：它变成可用之后，设备进程另开一条连接去读它自己的项目、分区和会话（只读）。
  // 这份数据目录是新的，读到的是空的；这里看的是真的 codex 把这几个方法都答了，没有一个被当成“没有”。
  const deviceLog = join(dirs.adapterHome, 'device', 'device.log')
  const importLines = () =>
    (existsSync(deviceLog) ? readFileSync(deviceLog, 'utf8') : '')
      .split('\n')
      .filter((line) => line.includes('导入') && line.includes('codex'))
  for (let attempt = 0; importLines().length === 0 && attempt < 100; attempt++) await pause(100)
  const imported = importLines().find((line) => /从 .*codex.* 导入了现有的项目/.test(line))
  const skippedReads = importLines().filter((line) => !/从 .*codex.* 导入了现有的项目/.test(line))
  if (imported && skippedReads.length === 0)
    passed(`首次导入读了它自己的项目：${imported.slice(imported.indexOf('从 '))}`)
  else
    console.log(
      `－ 首次导入没有完整读成（不算失败，按设计是跳过）：${JSON.stringify(importLines())}`,
    )

  // 关掉：app-server 收掉，状态是已停用
  mark = client.incoming.length
  await write([{ key: 'harness.codex.enabled', value: false }])
  await client.waitFor('Codex 变成停用', codexStatus('disabled'), mark)
  for (let attempt = 0; existsSync(runtimeSocket) && attempt < 100; attempt++) await pause(100)
  expect(!existsSync(runtimeSocket), '停用之后它的套接字应该没了')
  passed('在设置里关掉：app-server 收掉了')
  client.close()
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
}
const runtimeLog = join(dirs.adapterHome, 'codex', 'runtime.log')
const tail = (value) => value.split('\n').slice(-40).join('\n')
if (failure) {
  console.error(`✖ ${failure.message}`)
  console.error(`\n主进程的输出（末尾）：\n${tail(output)}`)
  if (existsSync(runtimeLog))
    console.error(`\ncodex 的运行日志（末尾）：\n${tail(readFileSync(runtimeLog, 'utf8'))}`)
}
// 主进程自己收场之后还留着的进程：有就是没收干净（下面会强杀它们）
await stopService()
await pause(300)
const left = leftovers()
await cleanup()
if (left.length > 0) {
  console.error(`✖ 主进程退出之后还留着 ${left.length} 个进程（已强杀）：${left.join('、')}`)
  process.exit(1)
}
if (failure) process.exit(1)
console.log(
  `检查通过：模型请求 ${model.requests()} 次，都打在回环上的假模型；没有留下进程和临时文件。`,
)
