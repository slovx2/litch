// 对照组（现有的 tyrs-hand 移动端，包名 com.tyrshand.app）的准备流程：按夹具的连接配置生成 Maestro 流程并跑一遍，
// 清空它的数据、加一条 SSH 连接（粘私钥、确认指纹）、经 SFTP 把夹具的工作目录加成项目、开一个新任务、在输入框里打好字。
// 不点发送：发送由 bench.mjs 在录屏开始后点，和原型的计时对齐。
// 测试标识照抄它自己的端到端流程（tyrs-hand/client/e2e/flows），流程文件写到 --out 目录里，不改那个仓库。
//
// 用法：node apps/mobile/scripts/legacy-flow.mjs --config <fixture.mjs 写的配置> --out <目录> [--prompt LONG_ANSWER] [--resume]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? fallback : process.argv[at + 1]
}
const config = JSON.parse(readFileSync(arg('--config'), 'utf8'))
const out = resolve(arg('--out', '.'))
const prompt = arg('--prompt', 'LONG_ANSWER')
const APP = 'com.tyrshand.app'
mkdirSync(out, { recursive: true })

const q = JSON.stringify
const tap = (id) => `- tapOn:\n    id: ${q(id)}\n`
const waitFor = (id, timeout = 30000) =>
  `- extendedWaitUntil:\n    visible:\n      id: ${q(id)}\n    timeout: ${timeout}\n`
const scrollTo = (id, direction = 'DOWN') =>
  `- scrollUntilVisible:\n    element:\n      id: ${q(id)}\n    direction: ${direction}\n    timeout: 15000\n`
const field = (id, text) => `${tap(id)}- eraseText: 100\n- inputText: ${q(text)}\n`

const { target } = config
// Android 的 inputText 会丢掉换行，私钥逐行输入再按回车（和它自己的运行器一样）
const key = target.privateKey
  .trim()
  .split('\n')
  .map((line) => `- inputText: ${q(line)}\n- pressKey: Enter\n`)
  .join('')
const segments = realpathSync(config.work).split('/').filter(Boolean)

const connection = [
  `- launchApp:\n    clearState: true\n    permissions:\n      all: allow\n`,
  waitFor('tab:connections'),
  tap('tab:connections'),
  scrollTo('connection:add-ssh', 'UP'),
  tap('connection:add-ssh'),
  field('connection:ssh:name', 'Fixture'),
  field('connection:ssh:host', target.host),
  field('connection:ssh:port', String(target.port)),
  field('connection:ssh:user', target.user),
  '- hideKeyboard\n',
  scrollTo('connection:ssh:private-key'),
  tap('connection:ssh:private-key'),
  key,
  '- hideKeyboard\n',
  scrollTo('connection:ssh:save'),
  tap('connection:ssh:save'),
  `- extendedWaitUntil:\n    visible: "确认并保存"\n    timeout: 30000\n- tapOn: "确认并保存"\n`,
]
const openPicker = [
  `- scrollUntilVisible:\n    element:\n      id: "connection:.*:add-project"\n    direction: DOWN\n    timeout: 30000\n`,
  `- tapOn:\n    id: "connection:.*:add-project"\n`,
  waitFor('connection:ssh:directory-list'),
]
const task = [
  tap('connection:ssh:add-current-directory'),
  waitFor('tab:connections'),
  // 10 月 1 日那版：会话标签页上直接是当前机器与项目，右下角加号开新任务
  tap('tab:sessions'),
  waitFor('session:new-task:add', 60000),
  tap('session:new-task:add'),
  tap('composer:input'),
  `- inputText: ${q(prompt)}\n`,
  waitFor('composer:send'),
]

const maestro = (name, steps) => {
  const file = join(out, `legacy-${name}.yaml`)
  writeFileSync(file, [`appId: ${APP}\n---\n`, ...steps].join(''))
  execFileSync(join(homedir(), '.local/bin/maestro'), ['test', '--no-ansi', file], {
    stdio: 'inherit',
    env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1' },
  })
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 16 << 20 })

/** 屏幕上文字正好是 text 的那个元素的中心点，没有就是 null */
function find(text) {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
  // dump 里表情这类字符写成数字实体（&#128193;），解开再比
  const decode = (raw) =>
    raw
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  for (const node of xml.split('<node ')) {
    const said = node.match(/ text="([^"]*)"/)
    if (!said || decode(said[1]) !== text) continue
    const box = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (box) return [(Number(box[1]) + Number(box[3])) >> 1, (Number(box[2]) + Number(box[4])) >> 1]
  }
  return null
}

/**
 * 目录一层层点进去。10 月 1 日那版的目录行没有测试标识，只能按文字（“📁 名字”，表情是 U+1F4C1）；
 * Maestro 在这个弹层的列表里滚不动，所以这段用 uiautomator 找、adb 点和滑
 */
async function walk() {
  for (const segment of segments) {
    const text = `\u{1F4C1} ${segment}`
    let at = null
    for (let tries = 0; tries < 40 && !at; tries += 1) {
      at = find(text)
      if (!at) {
        adb('shell', 'input', 'swipe', '540', '1900', '540', '700', '400')
        await sleep(600)
      }
    }
    if (!at) throw new Error(`目录里找不到 ${segment}`)
    adb('shell', 'input', 'tap', String(at[0]), String(at[1]))
    await sleep(1500)
  }
}

// --resume：连接已经加好了（上次跑到一半），从加项目接着来
maestro('connection', [...(process.argv.includes('--resume') ? [] : connection), ...openPicker])
await walk()
maestro('task', task)
console.log('旧端准备好了：输入框里已经打好字，等着点发送')
