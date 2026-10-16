// 侧面板里“差异”标签的验收：不显示窗口，起三次桌面外壳，各对着一种对面。
//   --mock     模拟核心（示例仓库，假的 git）：概况和内容、两种视图、折行、筛文件、展开上下文、上色、三种范围、
//              暂存和还原（还原先问）、代理改完文件回合结束后自己跟上、面板收着不取、从对话里过去、行内批注、
//              几百个文件、太大的文件、不是仓库的目录、降级的设备、最窄的窗口、六套外观、两种语言
//   --device   隔离的多 harness 设备（scripts/device-fixture.mjs）：git 由设备进程起，真的仓库
//   --entry    单个 harness 的入口（scripts/client-fixture.mjs）：git 由那个 harness 的运行时起
// 不带参数就是三种依次跑。量法在 src/probe-diff*.mts。
//
// 后两种要的仓库由这里在夹具自己的临时目录里现建（只往那里面写，git 的写操作也只对它做；夹具退出时连目录一起删）：
//   work/app/            工作区的根（夹具造的会话就在这里），在这里 git init、提交一次，再摆出这些没提交的改动：
//     src/app.ts         改了两处，隔得远（中间有没显示的行，给“展开上下文”用）；没暂存
//     README.md          加了一行，暂存了
//     notes.txt → renamed.txt   改了名，暂存了
//     old.txt            删了，没暂存
//     bin.dat            二进制，改了，没暂存
//     fresh.txt          没跟踪的新文件，四行
//     agent-notes.txt    提交过的：会话里说“改个文件”，假模型会接着往里写一行，再新写一个 agent-new.ts
//   notes/               另一个会话的工作目录，不是仓库
// 页面里的脚本打出 LITCH_SIGNAL diff-many 之后，这里再往 work/app/gen/ 里摆三百个新文件：看几百个文件时面板还用得动。
//
// 时间上的线有严和宽两套（src/probe-diff-judge.mts）：平时按严的；LITCH_CHECK_LENIENT=1 或者在流水线上（CI=true）
// 按宽的，只报数，只拦“卡死了”。功能对不对的检查两套一样严。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const only = ['mock', 'device', 'entry'].filter((name) => process.argv.includes(`--${name}`))
const wanted = only.length > 0 ? only : ['mock', 'device', 'entry']
const verbose = process.argv.includes('--verbose')

/** 收到信号之后往仓库里摆多少个文件（src/probe-diff-run.mts 里的 MANY_FILES 要和它一样） */
const MANY_FILES = 300

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
        // 等它真的退出：它要把运行时和设备进程收掉、把临时目录删了
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

/** 只认夹具报上来的那个目录下面的路径 */
function insideOf(root) {
  return (...parts) => {
    const path = join(root, ...parts)
    if (!root || !path.startsWith(`${root}/`)) throw new Error(`不在夹具的临时目录里：${path}`)
    return path
  }
}

/**
 * 在夹具的临时目录里建仓库、摆改动。git 只在 work/app 里跑：不读用户自己的 git 配置，
 * 也不许它往上找别的仓库（万一 init 没成，后面的命令宁可报错，不能落到外面的仓库上）。
 */
function arrange(root) {
  const inside = insideOf(root)
  const app = inside('work/app')
  const notes = inside('notes')
  if (!existsSync(app)) throw new Error(`夹具里没有工作区的目录：${app}`)
  const put = (content, ...parts) => {
    mkdirSync(dirname(inside(...parts)), { recursive: true })
    writeFileSync(inside(...parts), content)
  }
  const git = (...args) => {
    const done = spawnSync(
      'git',
      [
        '-c',
        'user.name=litch-check',
        '-c',
        'user.email=litch-check@localhost',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        cwd: app,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CEILING_DIRECTORIES: dirname(app),
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
      },
    )
    if (done.status !== 0)
      throw new Error(`git ${args.join(' ')} 没成（${done.status}）：${done.stderr || done.error}`)
    return done.stdout
  }
  const lines = (change = () => null) =>
    Array.from({ length: 40 }, (_, n) => change(n + 1) ?? `export const line${n + 1} = ${n + 1}`)
      .join('\n')
      .concat('\n')

  git('init', '-q', '-b', 'main')
  if (!existsSync(join(app, '.git'))) throw new Error(`没能在夹具的工作区里建出仓库：${app}`)
  put(lines(), 'work/app/src/app.ts')
  put('# app\n\nA fixture repository.\n', 'work/app/README.md')
  put('one\ntwo\nthree\nfour\nfive\nsix\n', 'work/app/notes.txt')
  put('gone 1\ngone 2\ngone 3\n', 'work/app/old.txt')
  put(Buffer.from(Array.from({ length: 512 }, (_, n) => (n * 7) % 256)), 'work/app/bin.dat')
  put('seed\n', 'work/app/agent-notes.txt')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')

  put(
    lines((n) => (n === 3 || n === 36 ? `export const line${n} = ${n * 100} // changed` : null)),
    'work/app/src/app.ts',
  )
  put('# app\n\nA fixture repository.\nWith one more line.\n', 'work/app/README.md')
  git('add', 'README.md')
  git('mv', 'notes.txt', 'renamed.txt')
  rmSync(inside('work/app/old.txt'))
  put(Buffer.from(Array.from({ length: 512 }, (_, n) => (n * 11) % 256)), 'work/app/bin.dat')
  put('fresh 1\nfresh 2\nfresh 3\nfresh 4\n', 'work/app/fresh.txt')

  mkdirSync(notes, { recursive: true })
  put('# 周报\n\n- 本周做完的\n', 'notes/weekly.md')
  return { app, notes, status: git('status', '--porcelain') }
}

/** 页面要的：往仓库里再摆几百个新文件 */
function arrangeMany(root) {
  const inside = insideOf(root)
  mkdirSync(inside('work/app/gen'), { recursive: true })
  for (let n = 0; n < MANY_FILES; n++) {
    writeFileSync(
      inside('work/app/gen', `file-${String(n).padStart(3, '0')}.txt`),
      `generated ${n}\nsecond line\n`,
    )
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
  const scratch = mkdtempSync(join(tmpdir(), 'litch-diff-'))
  const profile = join(scratch, 'profile')
  const fixture =
    kind === 'device'
      ? await startFixture('scripts/device-fixture.mjs', ['--workspaces'], 'LITCH_DEVICE_FIXTURE')
      : kind === 'entry'
        ? await startFixture('scripts/client-fixture.mjs', [], 'LITCH_FIXTURE')
        : null
  const outside = []
  let dirs = null
  // 入口夹具报的是 unix:// 开头的地址，设备夹具报的是套接字的路径
  const entry = fixture ? (fixture.info.socket ?? fixture.info.entry) : null
  if (fixture) {
    try {
      dirs = arrange(fixture.info.root)
    } catch (error) {
      outside.push(`没能在夹具的临时目录里建出仓库：${error.message}`)
    }
  }
  let output = ''
  let code = 1
  if (!fixture || dirs) {
    const child = spawn(electron, [appDir], {
      env: {
        ...process.env,
        LITCH_SMOKE: kind === 'mock' ? 'diff' : `diff-${kind}`,
        LITCH_PROFILE: profile,
        ...(entry ? { LITCH_ENTRY: entry } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    running = child
    if (stopped) child.kill('SIGKILL')
    let many = false
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk
        if (verbose) process.stderr.write(chunk)
        // 页面里的脚本要我们往仓库里摆几百个文件
        if (!many && fixture && output.includes('LITCH_SIGNAL diff-many')) {
          many = true
          try {
            arrangeMany(fixture.info.root)
          } catch (error) {
            outside.push(`没能往仓库里摆那几百个文件：${error.message}`)
          }
        }
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
  // 我们建的仓库、摆的文件要跟着夹具的临时目录一起没了。只看我们摆的：
  // 入口夹具收尾时引擎还在退出，会在删完之后又写回几个它自己的小目录，那不是这里摆的
  for (const mine of dirs ? [join(dirs.app, '.git'), join(dirs.app, 'gen'), dirs.notes] : []) {
    if (existsSync(mine)) outside.push(`建在夹具临时目录里的东西没删掉：${mine}`)
  }
  // 临时的用户数据目录在这里面
  rmSync(scratch, { recursive: true, force: true })
  if (existsSync(scratch)) outside.push(`临时目录没删掉：${scratch}`)
  const failed = [...(result?.failed ?? (result ? [] : ['没有拿到结果'])), ...outside]
  return { kind, code, result, failed, output, fixtureLog, status: dirs?.status ?? '' }
}

const NAMES = {
  mock: '模拟核心',
  device: '隔离设备（git 由设备进程起）',
  entry: '单个 harness 的入口',
}
let allOk = true
for (const kind of wanted) {
  if (stopped) break
  const run = await runOne(kind)
  if (stopped) {
    console.error('差异面板的验收被中途叫停了，已经收尾')
    process.exit(130)
  }
  const ok = run.failed.length === 0 && run.code === 0
  allOk &&= ok
  const lenient = run.result?.probe?.lenient ? '（宽的线：时间只报数）' : ''
  const numbers = run.result?.probe?.numbers ? `${run.result.probe.numbers}${lenient}` : ''
  if (ok) {
    console.log(`差异面板验收通过：${NAMES[kind]}${numbers ? `｜${numbers}` : ''}`)
  } else {
    console.error(`差异面板验收没过：${NAMES[kind]}（退出码 ${run.code}）`)
    for (const entry of run.failed) console.error(`  - ${entry}`)
    if (numbers) console.error(`  量到的：${numbers}`)
    console.error(
      run.output
        .split('\n')
        .filter((entry) => !entry.startsWith('LITCH_SMOKE '))
        .slice(-40)
        .join('\n'),
    )
    if (run.status) console.error(`建出来的仓库（git status）：\n${run.status}`)
    if (run.fixtureLog)
      console.error(`夹具的输出：\n${run.fixtureLog.split('\n').slice(-30).join('\n')}`)
  }
  if (process.argv.includes('--json') && run.result) {
    console.log(JSON.stringify(run.result.probe, null, 2))
  }
}
process.exit(allOk ? 0 : 1)
