// 确定性 TextEdit 保存验收，不调用模型；只操作本次启动的应用和 /tmp/litch-cu-trial。
// 需要用户明确允许占用电脑。权限/用户让行/停止检查全部经产品执行器，失败立即停止。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

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
const here = dirname(fileURLToPath(import.meta.url))
const [helperPath, output] = process.argv.slice(2)
assert(helperPath?.includes('/.artifacts/') && output, '需要独立签名探针路径及新记录目录')
const out = resolve(output)
assert(!existsSync(out) && !existsSync('/tmp/litch-cu-trial'), '记录或测试目录已存在，不接管')
const inspect = () =>
  JSON.parse(
    execFileSync('swift', [join(here, 'inspect-keyboard-target.swift')], { encoding: 'utf8' }),
  )
assert(!inspect().pid, 'TextEdit 已在运行，不接管用户应用；请先清理上轮测试')
mkdirSync(out, { recursive: true, mode: 0o700 })
const root = mkdtempSync('/tmp/litch-cu-save-panel-')
mkdirSync(join(root, 'home'))
const launcher = new MacLauncher({
  appPath: resolve(helperPath),
  directory: join(root, 'helper'),
  version: null,
  async launch(path, env) {
    execFileSync('open', [
      '-n',
      '-g',
      ...Object.entries({ ...env, HOME: join(root, 'home') }).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`,
      ]),
      path,
    ])
  },
})
const helper = new HelperSupervisor({ launcher, lang: () => 'zh-CN', log: () => {} })
const executor = createComputerExecutor({ helper })
const controller = new AbortController()
const app = 'com.apple.TextEdit'
const first = '今天测试桌面自动化，保留中文、数字 123 和标点。'
const second = '这一段需要加粗，用于检查选择与格式操作。'
let sequence = 0,
  ownPID,
  clean = false
const record = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2))
async function call(tool, args = {}) {
  const request = { tool, arguments: tool === 'run_actions' ? args : { app, ...args } }
  const result = await executor.call(
    {
      ...request,
      id: `save-${++sequence}`,
      callId: `save-${sequence}`,
      namespace: 'litch_computer',
      threadId: 'save-panel',
      turnId: 'save-panel',
      harness: null,
      cwd: root,
      device: { id: 'trial', name: 'Trial', kind: 'local', target: null },
    },
    { signal: controller.signal, ask: async () => null },
  )
  record(`result-${sequence}.json`, { request, result })
  for (const item of result.contentItems) {
    if (item.type === 'inputImage')
      writeFileSync(
        join(out, `state-${sequence}.jpg`),
        Buffer.from(item.imageUrl.split(',')[1], 'base64'),
      )
  }
  const text = result.contentItems
    .filter((item) => item.type === 'inputText')
    .map((item) => item.text)
    .join('\n')
  console.log(`${sequence}. ${tool}: ${result.success ? 'ok' : text}`)
  assert(result.success, text)
  return text
}
const step = (tool, args) => ({ tool, arguments: { app, ...args } })
const batch = (...actions) => call('run_actions', { actions })
async function zeroWindows() {
  await delay(1000)
  const state = await call('get_app_state', { full: true })
  assert.match(state, /Visible windows: 0; accessible window: none/)
  assert.equal(inspect().windowOwners.length, 0)
}
function quitOwned() {
  assert.equal(inspect().pid, ownPID)
  process.kill(ownPID, 'SIGTERM')
  ownPID = undefined
}
try {
  const client = await helper.client()
  const permissions = await client.request('permissions')
  record('preflight.json', permissions)
  assert(permissions.accessibility && permissions.screenRecording, '缺系统权限；停止，不代点')
  mkdirSync('/tmp/litch-cu-trial', { mode: 0o700 })
  execFileSync('open', ['-g', '-b', app])
  await delay(1000)
  ownPID = inspect().pid
  await zeroWindows()
  const document = await call('press_key', { key: 'cmd+n' })
  const area = Number(/\[(\d+)\] TextArea/.exec(document)?.[1])
  assert(area, '必须观察到新建文档的输入区')
  await batch(
    step('type_text', { element: area, text: `${first}\n${second}` }),
    step('select_text', { element: area, text: second }),
    step('press_key', { key: 'cmd+b' }),
    step('press_key', { key: 'cmd+s' }),
  )
  const panel = inspect()
  record('save-panel-target.json', panel)
  assert.equal(panel.focusIdentifier, 'saveAsNameTextField')
  assert.equal(panel.actualBundle, 'com.apple.appkit.xpc.openAndSavePanelService')
  assert.notEqual(panel.actualPID, panel.pid)
  const saveState = await call('get_app_state', { full: true })
  const filename = Number(/Save As control: \[(\d+)\]/.exec(saveState)?.[1])
  assert(filename, '文件名框必须来自当前观察')
  await batch(
    step('set_value', { element: filename, value: 'cu-note.rtf' }),
    step('press_key', { key: 'cmd+shift+g' }),
  )
  const goTo = await call('get_app_state', { full: true })
  assert.match(goTo, /TextField.*focused/)
  assert.notEqual(inspect().focusIdentifier, 'saveAsNameTextField', '前往文件夹必须实际打开')
  const pathField = Number(/\[(\d+)\] TextField[^\n]*focused/.exec(goTo)?.[1])
  assert(pathField, '路径框必须来自当前观察')
  await batch(
    step('set_value', { element: pathField, value: '/tmp/litch-cu-trial/' }),
    step('press_key', { key: 'Return' }),
  )
  const destination = inspect()
  record('destination.json', destination)
  assert.equal(destination.testDestination, true, '先核实目标目录，不能保存到默认 iCloud')
  assert.equal(destination.focusIsTestFilename, true)
  await call('press_key', { key: 'Return' })
  assert(existsSync('/tmp/litch-cu-trial/cu-note.rtf'), '保存必须实际落盘')
  const rtf = JSON.parse(
    execFileSync(
      'swift',
      [join(here, 'verify-rtf.swift'), '/tmp/litch-cu-trial/cu-note.rtf', first, second],
      { encoding: 'utf8' },
    ),
  )
  record('rtf.json', rtf)
  assert.equal(rtf.text, `${first}\n${second}`)
  assert(rtf.secondParagraphBold && !rtf.firstParagraphBold)
  copyFileSync('/tmp/litch-cu-trial/cu-note.rtf', join(out, 'cu-note.rtf'))
  await call('press_key', { key: 'cmd+w' })
  await zeroWindows()
  quitOwned()
  await delay(700)
  execFileSync('open', ['-g', '-b', app])
  await delay(1000)
  ownPID = inspect().pid
  await zeroWindows()
  const final = inspect()
  record('cleanup.json', final)
  assert.deepEqual(final.modifierFlags, [0, 0])
  quitOwned()
  rmSync('/tmp/litch-cu-trial/cu-note.rtf')
  rmdirSync('/tmp/litch-cu-trial')
  clean = true
  console.log('PASS: 前往文件夹、正确路径保存、RTF第二段粗体、重开不恢复、修饰键无残留')
} finally {
  controller.abort()
  executor.turnEnded({ deviceId: 'trial', threadId: 'save-panel', turnId: 'save-panel' })
  await helper.dispose()
  rmSync(root, { recursive: true, force: true })
  if (!clean)
    console.error(
      `验收停止；未盲目关闭窗口或删除文件。需核对清理 TextEdit PID=${ownPID ?? 'none'} 与 /tmp/litch-cu-trial。`,
    )
}
