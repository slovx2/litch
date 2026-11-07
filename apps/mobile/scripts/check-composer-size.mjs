// 专用 Android 隐藏模拟器上的输入框几何回归；先安装启用 E2E 的本分支 APK。
// node scripts/check-composer-size.mjs emulator-5592
// Maestro 负责正式入口导航；Android 无障碍树量实际像素，不用样式对象冒充原生布局。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const serial = process.argv[2]
assert.match(serial ?? '', /^emulator-\d+$/)
const adbBin = join(
  process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk'),
  'platform-tools/adb',
)
const adb = (...args) =>
  execFileSync(adbBin, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 8 << 20 })
assert.match(adb('emu', 'avd', 'name'), /^litch_/)
const lock = '/tmp/litch-maestro-7001.lock'
try {
  mkdirSync(lock)
} catch (error) {
  console.error(readFileSync('/tmp/litch-maestro-7001.lock/owner', 'utf8'))
  throw error
}
writeFileSync('/tmp/litch-maestro-7001.lock/owner', `composer-size PID=${process.pid}\n`)
const work = mkdtempSync(join(tmpdir(), 'litch-composer-size-'))
let child
const run = (steps) =>
  new Promise((resolve, reject) => {
    const file = join(work, 'flow.yaml')
    writeFileSync(file, `appId: dev.litch.app\n---\n${steps}\n`)
    child = spawn(
      process.env.MAESTRO ?? 'maestro',
      [
        '--udid',
        serial,
        'test',
        '--no-ansi',
        '--test-output-dir',
        work,
        '--debug-output',
        work,
        file,
      ],
      { stdio: 'inherit' },
    )
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Maestro ${code}`))))
  })
const box = (xml, id) => {
  const node = xml.split('<node ').find((node) => node.includes(`resource-id="${id}"`))
  const rect = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  assert.ok(rect, `缺少 ${id}`)
  const [left, top, right, bottom] = rect.slice(1).map(Number)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}
const capture = () => adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
const focus = (rect) =>
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round((rect.left + rect.right) / 2)),
    String(Math.round((rect.top + rect.bottom) / 2)),
  )
const replace = (text) => {
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A')
  adb('shell', 'input', 'keyevent', 'KEYCODE_DEL')
  if (text) adb('shell', 'input', 'text', text.replaceAll(' ', '%s'))
}
const measure = (id = 'composer-input') => {
  // 页面或键盘过渡后 Android 无障碍快照可能尚未含输入节点；只等节点，几何失败绝不重试。
  let xml = capture()
  const deadline = Date.now() + 15000
  while (!xml.includes(`resource-id="${id}"`) && Date.now() < deadline) xml = capture()
  const input = box(xml, id)
  if (id === 'composer-input') {
    const more = box(xml, 'composer-more')
    assert.ok(!xml.includes('resource-id="settings:usage"'), '用量入口不再占输入行')
    const end = box(xml, 'composer-send')
    const gap = input.left - more.right
    assert.ok(gap > 0)
    assert.ok(
      Math.abs(end.left - input.right - gap) <= 2,
      `输入框未填满剩余宽度：${JSON.stringify({ input, more, end })}`,
    )
  }
  return input
}
const exercise = (label, id = 'composer-input') => {
  let small = measure(id)
  const emptyHeight = small.height
  const availableWidth = small.width
  focus(small)
  replace('ab')
  small = measure(id)
  console.log(
    `${label} 空框/两字宽度：${JSON.stringify({ empty: availableWidth, short: measure(id).width })}`,
  )
  assert.equal(small.width, availableWidth, `${label} 空框与短文本同宽`)
  adb('shell', 'input', 'keycombination', 'KEYCODE_SHIFT_LEFT', 'KEYCODE_ENTER')
  const explicit = measure(id)
  assert.equal(explicit.width, small.width, `${label} 显式换行宽度不变`)
  assert.ok(explicit.height > small.height, `${label} 显式换行后高度增加`)
  const widthFactor = Math.max(1, Math.ceil(availableWidth / 775))
  replace(
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen '.repeat(
      widthFactor,
    ),
  )
  const multiline = measure(id)
  assert.ok(
    multiline.height > small.height,
    `${label} 多行未增高：${JSON.stringify({ small, multiline })}`,
  )
  replace('one two three four five six seven eight nine ten '.repeat(4 * widthFactor))
  const capped = measure(id)
  replace('one two three four five six seven eight nine ten '.repeat(6 * widthFactor))
  const longer = measure(id)
  assert.equal(longer.height, capped.height, `${label} 超限后框高不再增长`)
  assert.ok(capped.height >= multiline.height)
  replace('one')
  const cleared = measure(id)
  assert.equal(cleared.height, small.height, `${label} 删除后恢复最小高度`)
  for (let round = 0; round < 3; round++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    focus(measure(id))
    replace(round % 2 ? 'ab' : 'short')
    if (round === 1) {
      adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
      adb('shell', 'am', 'start', '-n', 'dev.litch.app/.MainActivity')
    }
    const again = measure(id)
    assert.equal(again.width, small.width, `${label} 第 ${round + 1} 次键盘和文字更新后宽度不变`)
  }
  replace('')
  // 运行中的长占位文字也参与原生测量，空框可比 one 更高，需恢复的是原来的空框高度。
  assert.equal(measure(id).height, emptyHeight)
  console.log(
    `${label}：宽 ${small.width}；高 ${small.height} → ${multiline.height} → ${capped.height} → ${cleared.height}，反复重排宽度不变`,
  )
}
try {
  await run(
    `- launchApp:\n    clearState: true\n- extendedWaitUntil:\n    visible:\n      id: devices\n    timeout: 30000\n- openLink: litch://boot?mode=mock\n- extendedWaitUntil:\n    visible:\n      id: devices:managers\n    timeout: 15000`,
  )
  for (const [id, label] of [
    ['p2', '空闲发送'],
    ['s2', '运行插话'],
  ]) {
    await run(
      `- openLink: litch://open?session=${id}&device=local\n- extendedWaitUntil:\n    visible:\n      id: composer-input\n    timeout: 15000`,
    )
    exercise(label)
    await run(
      `- tapOn:\n    id: composer-more\n- assertVisible:\n    id: settings:usage\n    text: ".*%.*"\n- tapOn:\n    id: settings:usage\n- assertVisible:\n    id: usage:sheet\n- back`,
    )
  }
  await run(
    `- openLink: litch://open?session=m1&device=local\n- extendedWaitUntil:\n    visible:\n      id: manager-tab:console\n    timeout: 15000\n- tapOn:\n    id: manager-tab:console\n- tapOn:\n    id: post-discussion:D-17\n- extendedWaitUntil:\n    visible:\n      id: post-question:D-17\n    timeout: 10000`,
  )
  exercise('讨论追问', 'post-question:D-17')
  console.log('COMPOSER_SIZE_PASS')
} finally {
  child?.kill()
  rmSync(work, { recursive: true })
  rmSync('/tmp/litch-maestro-7001.lock/owner')
  rmSync('/tmp/litch-maestro-7001.lock', { recursive: true })
}
