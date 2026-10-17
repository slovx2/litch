// 在模拟器上跑一个场景并录下来：清零帧统计、开始录屏、用链接触发、等到结束、取帧统计、拉回视频，
// 再交给 measure/ 分析（研究记录在 research/mobile-prototype-2026-10-17/）。
//
// 用法：node apps/mobile/scripts/bench.mjs --scenario t1 --variant A --out <目录> [--seconds 75] [--render md|plain] [--seal 300] [--pace 100] [--freeze 1|0] [--tail whole|open] [--no-measure] [--no-record] [--no-threads] [--app litch|legacy]
//   场景：t1    新建会话、长回答（约 62 秒），流式贴底；录到结束之后，定稿（T2）也从这段里量
//         t1x3  长回答三倍（约 21 秒）
//         t3    键盘弹出收起各 10 次
//         t4    进入含两轮十万字回答的会话，来回 5 次（进会话的耗时在 summary.json 的 opens）
//         t5    展开收起五十步的过程组
//         t6    往上翻，接 5 页以上更早的历史
//         t7    快速滑过 500 行以上
//         webview  WebView 里的终端吞吐（结果在 summary.json 的 webview）
//         idle  什么都不触发，只录（手动操作时用）
// 对照组：--app legacy（先跑 legacy-flow.mjs），只用 t1，提示词在流程里打好（LONG_ANSWER）
// 原型要已经装好、开着，并且连上了夹具（fixture.mjs --serve 8765 --adb）。
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? fallback : process.argv[at + 1]
}
const scenario = arg('--scenario', 't1')
const variant = arg('--variant', 'A')
const render = arg('--render', 'md')
const seal = arg('--seal', '300')
const pace = arg('--pace', '100')
const freeze = arg('--freeze', '1')
const tail = arg('--tail', 'whole')
if (!['md', 'plain'].includes(render) || !/^\d+$/.test(seal) || !/^\d+$/.test(pace)) {
  throw new Error(`参数不对：render=${render} seal=${seal} pace=${pace}`)
}
const out = resolve(arg('--out', '.'))
// legacy：对照组，现有的 tyrs-hand 移动端。它不认链接，要先用 legacy-flow.mjs 把新任务开好、字打好，这里只点发送
const app = arg('--app', 'litch')
const pkg = app === 'legacy' ? 'com.tyrshand.app' : 'dev.litch.app'
const measure = !process.argv.includes('--no-measure')
// 不录屏：录屏本身占模拟器的 GPU，只看帧统计时关掉，排除它的影响
const record = !process.argv.includes('--no-record')
// 不采线程 CPU：top 每秒扫一遍也占 CPU，要排除它的影响时关掉
const threads = !process.argv.includes('--no-threads')
// 用 simpleperf 采 JS 线程（要 adb root）：触发后第 8 秒起采 20 秒，算 JS 线程忙的比例和其中排版测量占多少
const perf = process.argv.includes('--perf')
// 各场景：prepare 在录屏之前做（造会话、进到该在的那一屏），act 在录屏开始后做。
// T2（定稿）不单列：t1 录到流式结束之后，从同一段视频里量。
const SCENARIOS = {
  t1: { seconds: 75, act: () => create('长回答') },
  t1x3: { seconds: 32, act: () => create('长回答三倍') },
  // T3：键盘弹出收起各 10 次
  t3: {
    seconds: 34,
    prepare: async () => {
      create('短回答')
      await sleep(5000)
    },
    act: async () => {
      const input = center('composer-input')
      for (let round = 0; round < 10; round += 1) {
        tap(input)
        await sleep(1400)
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        await sleep(1400)
      }
    },
  },
  // T4：进入含十万字回答的会话，来回 5 次
  t4: {
    seconds: 34,
    prepare: () => seedHuge(),
    act: async () => {
      for (let round = 0; round < 5; round += 1) {
        link(`open?session=last&markers=1&variant=${variant}`)
        await sleep(4000)
        link('home')
        await sleep(2000)
      }
    },
  },
  // T5：展开收起一个五十步的过程组，3 来回
  t5: {
    seconds: 20,
    prepare: async () => {
      create('五十步')
      await sleep(25000)
    },
    act: async () => {
      const toggle = center('process-toggle')
      for (let round = 0; round < 6; round += 1) {
        tap(toggle)
        await sleep(2500)
      }
    },
  },
  // T6：往上翻，接 5 页以上更早的历史（界面这层分页，一页 40 行）：甩一下、停 2.5 秒，停着的时候内容不许动
  t6: {
    seconds: 66,
    prepare: async () => {
      await seedHuge()
      link(`open?session=last&markers=1&variant=${variant}`)
      await sleep(4000)
    },
    act: async () => {
      for (let round = 0; round < 24; round += 1) {
        swipe('500', '2000', 60)
        await sleep(2200)
      }
    },
  },
  // T7：快速滑过 500 行以上：往上猛甩 50 次，再往下猛甩 50 次（甩到哪了看 probe.json 的 offset 和 page）
  t7: {
    seconds: 80,
    prepare: async () => {
      await seedHuge()
      link(`open?session=last&markers=1&variant=${variant}`)
      await sleep(4000)
    },
    act: async () => {
      for (const [from, to] of [
        ['500', '2000'],
        ['2000', '500'],
      ]) {
        for (let round = 0; round < 50; round += 1) {
          swipe(from, to, 40)
          await sleep(300)
        }
      }
    },
  },
  // WebView 吞吐：进测试页，页面自己跑完来回、匀速、猛灌三段（src/bench/WebViewBench.tsx）
  webview: { seconds: 45, act: () => link('bench') },
  idle: { seconds: 30, act: () => {} },
}
const plan = SCENARIOS[scenario]
if (!plan) throw new Error(`不认识的场景：${scenario}`)
const seconds = Number(arg('--seconds', plan.seconds))
mkdirSync(out, { recursive: true })

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
const adbAsync = promisify(execFile)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const link = (path) =>
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'litch://${path}'`)
// 录屏开始以来的动作时刻（秒），写进 meta.json 的 actions：分析时按它切出“手指离开、停稳了”的那几段
const actions = []
let recordingAt = 0
const mark = (kind) => actions.push({ t: Math.round((Date.now() - recordingAt) / 10) / 100, kind })
const swipe = (from, to, ms) => {
  adb('shell', 'input', 'swipe', '540', from, '540', to, String(ms))
  mark('swipe-end')
}
const tap = ([x, y]) => adb('shell', 'input', 'tap', String(x), String(y))
const create = (prompt) =>
  link(`new?prompt=${encodeURIComponent(prompt)}&markers=1&variant=${variant}&render=${render}`)

/** 造一个两轮十万字回答的会话（五百多行），回首页 */
async function seedHuge() {
  create('十万字')
  await sleep(12000)
  link(`send?text=${encodeURIComponent('十万字')}`)
  await sleep(12000)
  link('home')
  await sleep(2000)
}

/** 屏幕上测试标识为 id 的元素的中心点 */
function center(id) {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
  const node = xml.split('<node ').find((item) => item.includes(`resource-id="${id}"`))
  const box = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if (!box) throw new Error(`屏幕上没有 ${id}`)
  return [(Number(box[1]) + Number(box[3])) >> 1, (Number(box[2]) + Number(box[4])) >> 1]
}

// 先让应用连上夹具（核心换成 fixture 装法，已经是就什么都不做），再回首页，标记线打开
const send = app === 'legacy' ? center('composer:send') : null
if (!send) {
  link('boot?mode=fixture')
  await sleep(4000)
}
if (!send)
  link(
    `home?markers=1&variant=${variant}&render=${render}&seal=${seal}&pace=${pace}&freeze=${freeze}&tail=${tail}&probe=1`,
  )
await sleep(1500)
if (!send && plan.prepare) await plan.prepare()
adb('shell', 'dumpsys', 'gfxinfo', pkg, 'reset')
adb('logcat', '-c')
const remote = '/sdcard/litch-bench.mp4'
recordingAt = Date.now()
const recorder = record
  ? spawn('adb', [
      'shell',
      'screenrecord',
      '--bit-rate',
      '20000000',
      '--time-limit',
      String(seconds),
      remote,
    ])
  : null
// 录屏结束得可能比下面的采样早，先把“结束了”接住
const recorded = recorder ? new Promise((done) => recorder.on('exit', done)) : null
await sleep(1500)
const started = Date.now()
const acting = send ? tap(send) : plan.act()
// 各线程的 CPU：JS 线程（mqt_v_js / mqt_js）、主线程、渲染线程。对照组没有 JS 探针，看 JS 线程忙不忙只能靠这个
const pid = adb('shell', 'pidof', pkg).trim()
const top =
  threads &&
  adbAsync(
    'adb',
    [
      'shell',
      'top',
      '-H',
      '-b',
      '-d',
      '1',
      '-n',
      String(Math.max(1, seconds - 4)),
      '-p',
      pid,
      '-o',
      'TID,%CPU,CMD',
    ],
    { maxBuffer: 64 << 20 },
  )
const perfDone = perf ? samplePerf() : null
// framestats 每次只给最近 120 帧，每秒取一次、按 IntendedVsync 去重，就有了整段的逐帧数据
const frames = new Map()
let header = null
const deadline = started + seconds * 1000 - 1500
while (Date.now() < deadline) {
  const { stdout } = await adbAsync('adb', ['shell', 'dumpsys', 'gfxinfo', pkg, 'framestats'], {
    maxBuffer: 64 << 20,
  })
  collectFrames(stdout)
  await sleep(1000)
}
await acting
if (recorded) await recorded
const gfx = adb('shell', 'dumpsys', 'gfxinfo', pkg)
const framestats = adb('shell', 'dumpsys', 'gfxinfo', pkg, 'framestats')
writeFileSync(join(out, 'gfxinfo.txt'), gfx)
writeFileSync(join(out, 'framestats.txt'), framestats)
collectFrames(framestats)
const rows = [...frames.values()].sort((a, b) => a.IntendedVsync - b.IntendedVsync)
writeFileSync(
  join(out, 'frames.csv'),
  [header.join(','), ...rows.map((row) => header.map((key) => row[key]).join(','))].join('\n'),
)
const logLines = adb('logcat', '-d', '-s', 'ReactNativeJS:I').split('\n')
const tagged = (tag) =>
  logLines
    .map((line) => line.match(new RegExp(`${tag} (\\{.*\\})`))?.[1])
    .filter(Boolean)
    .map((text) => JSON.parse(text))
const probes = tagged('LITCH_PROBE')
const opens = tagged('LITCH_PROBE_OPEN')
const webview = tagged('LITCH_WEBVIEW')
writeFileSync(join(out, 'probe.json'), `${JSON.stringify(probes, null, 1)}\n`)
const { stdout: topText } = top ? await top : { stdout: '' }
const perfSummary = perfDone ? await perfDone : null
writeFileSync(join(out, 'threads.txt'), topText)
const summary = {
  app,
  opens,
  webview,
  frames: summarizeFrames(rows),
  js: summarizeProbes(probes),
  threads: top ? summarizeThreads(topText) : null,
  perf: perfSummary,
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
if (recorder) {
  await sleep(1000)
  adb('pull', remote, join(out, 'video.mp4'))
  adb('shell', 'rm', '-f', remote)
}
writeFileSync(
  join(out, 'meta.json'),
  `${JSON.stringify({ app, scenario, variant, render, seal, pace, freeze, tail, seconds, record, actions, triggeredAtMs: started, pkg }, null, 2)}\n`,
)
console.log(`录好了：${out}`)

if (measure) {
  const tool = join(here, '../measure')
  const run = (...args) =>
    execFileSync('uv', ['run', 'python', '-m', 'chatmeasure', ...args], {
      cwd: tool,
      stdio: 'inherit',
    })
  run('frametimes', join(out, 'gfxinfo.txt'), '--json', join(out, 'gfx.json'))
  if (recorder && ['t1', 't1x3', 't3', 't4'].includes(scenario)) {
    run(
      'markers',
      join(out, 'video.mp4'),
      '--x-range',
      '0,256',
      '--scale',
      '0.5',
      '--line-height-dp',
      '22',
      '--json',
      join(out, 'markers.json'),
      '--csv',
      join(out, 'markers.csv'),
    )
  }
}

function collectFrames(text) {
  const parts = text.split('---PROFILEDATA---')
  for (let i = 1; i < parts.length; i += 2) {
    const lines = parts[i].trim().split('\n')
    header ??= lines[0].split(',').filter(Boolean)
    for (const line of lines.slice(1)) {
      const values = line.split(',')
      const row = Object.fromEntries(header.map((key, at) => [key, Number(values[at])]))
      if (row.Flags === 0) frames.set(row.IntendedVsync, row)
    }
  }
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const round = (ms) => Math.round(ms * 10) / 10
  return {
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  }
}

/**
 * 按线程拆开每帧的耗时（毫秒）。模拟器上 GPU 那段是宿主机把 GLES 翻成 Metal 的时间，和真机不可比，单列出来不进判断；
 * 能代表应用自身开销的是 ui（主线程：输入、动画、测量布局、录制绘制）和 rt（渲染线程：同步、下发绘制命令）
 */
function summarizeFrames(rows) {
  const ms = (from, to) => rows.map((row) => (row[to] - row[from]) / 1e6)
  const ui = ms('HandleInputStart', 'SyncQueued')
  const rt = ms('SyncStart', 'SwapBuffers')
  return {
    count: rows.length,
    ui: percentiles(ui),
    rt: percentiles(rt),
    gpuAndQueue: percentiles(ms('SwapBuffers', 'FrameCompleted')),
    total: percentiles(ms('IntendedVsync', 'FrameCompleted')),
    uiOver8: ui.filter((v) => v > 8).length,
    uiOver16: ui.filter((v) => v > 16).length,
    rtOver8: rt.filter((v) => v > 8).length,
  }
}

function summarizeProbes(probes) {
  if (probes.length === 0) return null
  return {
    seconds: probes.length,
    lagP95Max: Math.max(...probes.map((p) => p.lagP95)),
    lagMax: Math.max(...probes.map((p) => p.lagMax)),
    over50: probes.reduce((sum, p) => sum + p.over50, 0),
  }
}

/** top 每秒一屏；按线程名归成 js / main / render / other，每屏求和，再看整段的平均和高位 */
function summarizeThreads(text) {
  const samples = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('Threads:')) {
      current = { js: 0, main: 0, render: 0, other: 0 }
      samples.push(current)
      continue
    }
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/)
    if (!match || !current) continue
    const cpu = Number(match[2])
    const name = match[3]
    const bucket = /mqt_(v_)?js/.test(name)
      ? 'js'
      : match[1] === pid
        ? 'main'
        : name === 'RenderThread'
          ? 'render'
          : 'other'
    current[bucket] += cpu
  }
  const used = samples.slice(1)
  const stat = (key) => {
    const values = used.map((sample) => sample[key]).sort((a, b) => a - b)
    const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)
    return {
      mean: Math.round(mean),
      p90: Math.round(values[Math.floor(values.length * 0.9)] ?? 0),
      max: Math.round(values.at(-1) ?? 0),
    }
  }
  return {
    samples: used.length,
    js: stat('js'),
    main: stat('main'),
    render: stat('render'),
    other: stat('other'),
  }
}

async function samplePerf() {
  await sleep(8000)
  const jsThread = adb('shell', 'ps', '-T', '-p', pid)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((cols) => /^mqt_(v_)?js$/.test(cols.at(-1) ?? ''))?.[2]
  if (!jsThread) return null
  const seconds = 20
  const file = '/data/local/tmp/litch-bench.perf'
  await adbAsync('adb', [
    'shell',
    'simpleperf',
    'record',
    '-t',
    jsThread,
    '-e',
    'cpu-clock',
    '-g',
    '-f',
    '1000',
    '--duration',
    String(seconds),
    '-o',
    file,
  ])
  const { stdout } = await adbAsync(
    'adb',
    ['shell', 'simpleperf', 'report', '-i', file, '--children', '--sort', 'symbol'],
    { maxBuffer: 256 << 20 },
  )
  writeFileSync(join(out, 'perf-js.txt'), stdout)
  const samples = Number(stdout.match(/Samples: (\d+)/)?.[1] ?? 0)
  const share = (pattern) => {
    const line = stdout.split('\n').find((text) => pattern.test(text))
    return line ? Number(line.trim().split(/\s+/)[0].replace('%', '')) : 0
  }
  const busy = samples / (seconds * 1000)
  // 各项都是占 JS 线程忙碌时间的比例，换算成占墙钟时间的比例
  const wall = (pct) => Math.round(busy * pct * 10) / 10
  return {
    busyPercent: Math.round(busy * 1000) / 10,
    commitPercent: wall(share(/UIManager::completeSurface/)),
    textMeasurePercent: wall(share(/measureContent\(/)),
  }
}
