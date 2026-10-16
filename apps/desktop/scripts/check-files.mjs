// 侧面板和文件标签的验收：不显示窗口，起三次桌面外壳，各对着一种对面。
//   --mock     模拟核心（示例文件树）：面板的开合与让位、树、查看器、找文件、右键菜单、对话里的路径、
//              换会话面板跟着换、降级的设备、皮肤、语言、快捷键和应用菜单
//   --device   隔离的多 harness 设备（scripts/device-fixture.mjs）：文件由设备进程读，真的文件系统
//   --entry    单个 harness 的入口（scripts/client-fixture.mjs）：文件由那个 harness 的运行时读
// 不带参数就是三种依次跑。量法在 src/probe-files*.mts。
//
// 后两种要的文件由这里摆进夹具自己的临时目录（只往那里面写，夹具退出时连目录一起删）：
//   work/app/            项目的根（夹具造的会话就在这里）
//     many/              三万个条目：30 个目录 group-00…，再加 item-00000.txt…
//     src/long.ts        六千行；src/app.ts 一个小的
//     lib/deep/nested/needle-file.ts   给“找文件”找的，藏在没展开过的目录里
//     notes.txt          二十行文字；big.log 超过显示上限；blob.dat 不是文字；shot.png 看扩展名就不读
//     empty/             空目录；.hidden.txt、.config/ 隐藏的
//     link-dir → src、link-file → notes.txt、link-broken → 不存在的、link-out → 根外面的 outside/
//   outside/secret.txt   在项目的根之外（还在夹具的临时目录里）：验“根之外的路径被拒”
//   notes/weekly.md      另一个会话的工作目录里放一个文件
//
// 时间上的线（展开大目录、帧间隔、开大文件、定位到行）有严和宽两套（src/probe-files-judge.mts）：
// 平时按严的；LITCH_CHECK_LENIENT=1 或者在流水线上（CI=true）按宽的，只报数，只拦“卡死了”。
// 功能对不对的检查两套一样严。
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const only = ['mock', 'device', 'entry'].filter((name) => process.argv.includes(`--${name}`))
const wanted = only.length > 0 ? only : ['mock', 'device', 'entry']
const verbose = process.argv.includes('--verbose')

/** 三万个条目的目录里放多少个目录、多少个文件 */
const MANY_DIRS = 30
const MANY_FILES = 30_000

/** 起一个夹具脚本，等它打出就绪的那一行。返回那一行里的内容和结束它的函数 */
function startFixture(script, args, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise((done) => child.on('exit', done))
    let output = ''
    let ready = false
    const onData = (chunk) => {
      output += chunk
      if (ready) return
      const line = output.split('\n').find((entry) => entry.startsWith(`${marker} `))
      if (!line) return
      ready = true
      resolve({
        info: JSON.parse(line.slice(marker.length + 1)),
        log: () => output,
        // 等它真的退出：它要把运行时和设备进程收掉、把临时目录删了（里面有我们摆的三万个文件）
        stop() {
          child.kill('SIGTERM')
          return Promise.race([exited, new Promise((done) => setTimeout(done, 30_000))])
        },
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`夹具没起来（退出码 ${code}）：\n${output}`)))
  })
}

/** 往夹具的临时目录里摆文件。只认夹具报上来的那个目录下面的路径 */
function arrange(root) {
  const inside = (...parts) => {
    const path = join(root, ...parts)
    if (!root || !path.startsWith(`${root}/`)) throw new Error(`不在夹具的临时目录里：${path}`)
    return path
  }
  const app = inside('work/app')
  const notes = inside('notes')
  const outside = inside('outside')
  if (!existsSync(app)) throw new Error(`夹具里没有项目的目录：${app}`)
  const dir = (...parts) => mkdirSync(inside(...parts), { recursive: true })
  const put = (content, ...parts) => writeFileSync(inside(...parts), content)
  const pad = (n, width) => String(n).padStart(width, '0')

  dir('work/app/many')
  for (let n = 0; n < MANY_DIRS; n++) dir('work/app/many', `group-${pad(n, 2)}`)
  for (let n = 0; n < MANY_FILES; n++)
    closeSync(openSync(inside('work/app/many', `item-${pad(n, 5)}.txt`), 'w'))

  dir('work/app/src')
  put(
    Array.from(
      { length: 6000 },
      (_, n) => `export const value${n + 1}: number = ${n + 1} // 第 ${n + 1} 行`,
    ).join('\n'),
    'work/app/src/long.ts',
  )
  put("export const app = 'litch'\n", 'work/app/src/app.ts')
  dir('work/app/lib/deep/nested')
  put('export const needle = true\n', 'work/app/lib/deep/nested/needle-file.ts')
  put(Array.from({ length: 20 }, (_, n) => `notes line ${n + 1}`).join('\n'), 'work/app/notes.txt')
  // 显示上限是 2 MiB（核心的 MAX_TEXT_BYTES）：放一个三兆的
  put('2026-10-13T08:00:00Z INFO entry ready\n'.repeat(80_000), 'work/app/big.log')
  put(Buffer.from(Array.from({ length: 2048 }, (_, n) => (n * 7) % 256)), 'work/app/blob.dat')
  put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'work/app/shot.png')
  dir('work/app/empty')
  put('hidden\n', 'work/app/.hidden.txt')
  dir('work/app/.config')
  put('{}\n', 'work/app/.config/settings.json')

  dir('outside')
  put('outside-secret\n', 'outside/secret.txt')
  symlinkSync('src', inside('work/app/link-dir'))
  symlinkSync('notes.txt', inside('work/app/link-file'))
  symlinkSync('nowhere', inside('work/app/link-broken'))
  symlinkSync('../../outside', inside('work/app/link-out'))

  dir('notes')
  put('# 周报\n\n- 本周做完的\n', 'notes/weekly.md')
  return { app, notes, outside }
}

/** 发一个请求、等它的应答的小客户端：只够从外面直接问一问对面的文件接口 */
function openPeer(socket) {
  const { WebSocket } = require('ws')
  return new Promise((resolve, reject) => {
    // 路径不写进地址：地址里的路径会被转义，临时目录带空格或汉字时连的就不是那个文件了
    const ws = new WebSocket('ws://localhost/', {
      perMessageDeflate: false,
      createConnection: () => connect(socket),
    })
    const pending = new Map()
    let seq = 1
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.id === undefined || message.method) return
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    ws.once('error', reject)
    ws.once('open', () =>
      resolve({
        /** 应答原样给回来（成了是 result，没成是 error） */
        ask: (method, params = {}) =>
          new Promise((done) => {
            const id = seq++
            pending.set(id, done)
            ws.send(JSON.stringify({ id, method, params }))
          }),
        notify: (method) => ws.send(JSON.stringify({ method })),
        close: () => ws.close(),
      }),
    )
  })
}

/**
 * 对面的文件接口现在是什么样：从另一条连接直接问，和界面那条没关系。只记不拦——
 * 这几样是适配器那一头的事，客户端是照着它现在的样子做的（符号链接要补问、读之前问不到大小、越界要自己拦）。
 */
async function remoteFacts(socket, dirs, aggregate) {
  const peer = await openPeer(socket)
  try {
    const hello = await peer.ask('initialize', {
      clientInfo: { name: 'litch-check-files', title: null, version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        // 设备的聚合面要声明了才给；单个 harness 的入口不认识这一项，不带
        ...(aggregate ? { litchExtensions: ['harness'] } : {}),
      },
    })
    if (hello.error) throw new Error(`握手没成：${hello.error.code} ${hello.error.message}`)
    peer.notify('initialized')
    const listed = await peer.ask('fs/readDirectory', { path: dirs.app })
    const flags = (name) => {
      const entry = listed.result?.entries?.find((item) => item.fileName === name)
      return entry ? `目录=${entry.isDirectory} 文件=${entry.isFile}` : '没列出来'
    }
    const meta = await peer.ask('fs/getMetadata', { path: join(dirs.app, 'big.log') })
    const gone = await peer.ask('fs/getMetadata', { path: join(dirs.app, 'no-such-file') })
    const broken = await peer.ask('fs/getMetadata', { path: join(dirs.app, 'link-broken') })
    const big = await peer.ask('fs/readFile', { path: join(dirs.app, 'big.log') })
    const out = await peer.ask('fs/readFile', { path: join(dirs.outside, 'secret.txt') })
    const error = (reply) =>
      reply.error ? `${reply.error.code} ${String(reply.error.message).slice(0, 80)}` : '没报错'
    return [
      `列目录时指向目录的符号链接：${flags('link-dir')}；指向文件的：${flags('link-file')}；断了的：${flags('link-broken')}`,
      `元数据里有：${Object.keys(meta.result ?? {}).join('、')}（没有大小）`,
      `问一个不存在的文件：${error(gone)}；问断了的符号链接：${error(broken)}`,
      `读三兆的文件：${big.result ? `整个读回来了，base64 ${big.result.dataBase64.length} 个字` : error(big)}`,
      `读项目根之外的文件：${out.result ? '读得到（对面不拦，要客户端自己拦）' : error(out)}`,
    ]
  } finally {
    peer.close()
  }
}

// 中途被叫停（Ctrl+C、被上层结束）：把正在跑的外壳结束掉，runOne 照常收尾（夹具、临时目录），
// 收完就退出，剩下的不跑了
let stopped = false
let running = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
    running?.kill('SIGKILL')
  })
}

/** 起一次外壳跑一种验收。返回它打出来的结果，和外面另外查到的不合格项 */
async function runOne(kind) {
  const scratch = mkdtempSync(join(tmpdir(), 'litch-files-'))
  const profile = join(scratch, 'profile')
  const fixture =
    kind === 'device'
      ? await startFixture('scripts/device-fixture.mjs', ['--workspaces'], 'LITCH_DEVICE_FIXTURE')
      : kind === 'entry'
        ? await startFixture('scripts/client-fixture.mjs', [], 'LITCH_FIXTURE')
        : null
  const outside = []
  let dirs = null
  let facts = []
  // 入口夹具报的是 unix:// 开头的地址，设备夹具报的是套接字的路径
  const entry = fixture ? (fixture.info.socket ?? fixture.info.entry) : null
  if (fixture) {
    try {
      dirs = arrange(fixture.info.root)
    } catch (error) {
      outside.push(`没能把文件摆进夹具的临时目录：${error.message}`)
    }
    if (dirs) {
      facts = await remoteFacts(entry.replace(/^unix:\/\//, ''), dirs, kind === 'device').catch(
        (error) => [`没能从外面直接问对面的文件接口：${error.message}`],
      )
    }
  }
  let output = ''
  let code = 1
  if (!fixture || dirs) {
    const child = spawn(electron, [appDir], {
      env: {
        ...process.env,
        LITCH_SMOKE: kind === 'mock' ? 'files' : `files-${kind}`,
        LITCH_PROFILE: profile,
        ...(entry ? { LITCH_ENTRY: entry, LITCH_FILES_DIRS: JSON.stringify(dirs) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    running = child
    if (stopped) child.kill('SIGKILL')
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk
        if (verbose) process.stderr.write(chunk)
      })
    }
    // 外壳自己有时限（模拟核心 5 分钟，另两种 7 分钟），到点会把走到哪一步报出来；这里是它连报都没报时的最后一道
    const startedAt = Date.now()
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, 480_000)
    code = await new Promise((done) => child.on('exit', done))
    clearTimeout(timer)
    running = null
    if (killed) {
      outside.push(
        `外壳 ${Math.round((Date.now() - startedAt) / 1000)} 秒没有结束，被强行结束了；它一共输出了 ${output.length} 个字`,
      )
    }
  }
  const line = output.split('\n').find((item) => item.startsWith('LITCH_SMOKE '))
  let result = null
  try {
    result = line ? JSON.parse(line.slice('LITCH_SMOKE '.length)) : null
  } catch {
    // 结果行不完整
  }
  const fixtureLog = fixture?.log() ?? ''
  await fixture?.stop()
  // 我们摆进去的那些（三万个文件）要跟着夹具的临时目录一起没了。只看我们摆的：
  // 入口夹具收尾时引擎还在退出，会在删完之后又写回几个它自己的小目录，那不是这里摆的
  for (const mine of dirs ? [join(dirs.app, 'many'), dirs.outside] : []) {
    if (existsSync(mine)) outside.push(`摆进夹具临时目录的文件没删掉：${mine}`)
  }
  // 临时的用户数据目录在这里面
  rmSync(scratch, { recursive: true, force: true })
  if (existsSync(scratch)) outside.push(`临时目录没删掉：${scratch}`)
  const failed = [...(result?.failed ?? (result ? [] : ['没有拿到结果'])), ...outside]
  return { kind, code, result, failed, output, fixtureLog, facts }
}

const NAMES = {
  mock: '模拟核心',
  device: '隔离设备（文件由设备进程读）',
  entry: '单个 harness 的入口',
}
let allOk = true
for (const kind of wanted) {
  if (stopped) break
  const run = await runOne(kind)
  if (stopped) {
    console.error('文件面板的验收被中途叫停了，已经收尾')
    process.exit(130)
  }
  const ok = run.failed.length === 0 && run.code === 0
  allOk &&= ok
  const lenient = run.result?.probe?.lenient ? '（宽的线：时间只报数）' : ''
  const numbers = run.result?.probe?.numbers ? `${run.result.probe.numbers}${lenient}` : ''
  if (ok) {
    console.log(`文件面板验收通过：${NAMES[kind]}${numbers ? `｜${numbers}` : ''}`)
  } else {
    console.error(`文件面板验收没过：${NAMES[kind]}（退出码 ${run.code}）`)
    for (const entry of run.failed) console.error(`  - ${entry}`)
    if (numbers) console.error(`  量到的：${numbers}`)
    console.error(
      run.output
        .split('\n')
        .filter((entry) => !entry.startsWith('LITCH_SMOKE '))
        .slice(-40)
        .join('\n'),
    )
    if (run.fixtureLog)
      console.error(`夹具的输出：\n${run.fixtureLog.split('\n').slice(-30).join('\n')}`)
  }
  // 对面的文件接口现在的样子：只记不拦（见 remoteFacts）
  const tree = run.result?.probe?.tree
  if (kind !== 'mock') {
    for (const fact of run.facts) console.log(`  对面的现状：${fact}`)
    if (tree?.viaLink)
      console.log(
        `  已知拦不住的：经过指向根外面的符号链接去读，${tree.viaLink}（设备会跟着链接走）`,
      )
  }
  if (process.argv.includes('--json') && run.result) {
    console.log(JSON.stringify(run.result.probe, null, 2))
  }
}
process.exit(allOk ? 0 : 1)
