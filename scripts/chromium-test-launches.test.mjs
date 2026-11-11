import assert from 'node:assert/strict'
import test from 'node:test'
import { withChromiumTestArgs } from './chromium-test-args.mjs'
import { chromiumTestLaunches } from './chromium-test-launches.mjs'

const imported = "import { withChromiumTestArgs as safeArgs } from './chromium-test-args.mjs';\n"
const checked = (source) =>
  chromiumTestLaunches(imported + source).map((launch) => launch.protected)

test('隔离开关总会传入实际参数，保留其他参数且不修改调用方数组', () => {
  const args = [
    'main.mjs',
    '--headless=new',
    '--password-store=keychain',
    '--use-mock-keychain=false',
  ]
  assert.deepEqual(withChromiumTestArgs(args), [
    'main.mjs',
    '--headless=new',
    '--use-mock-keychain',
    '--password-store=basic',
  ])
  assert.equal(args.length, 4)
  assert.deepEqual(withChromiumTestArgs(), ['--use-mock-keychain', '--password-store=basic'])
})

test('CDP、Electron、Playwright 与 Launch Services 都检查实际参数', () => {
  for (const source of [
    "spawn(chrome, safeArgs(['--headless=new']))",
    "spawn(require('electron'), safeArgs(['main.mjs']))",
    'const binary = process.env.LITCH_CHROME_BINARY; execFileSync(binary, safeArgs([]))',
    'const args = safeArgs([]); spawn(electron, args)',
    'chromium.launch({ args: safeArgs([]), headless: true })',
    'chromium.launchPersistentContext(profile, { args: safeArgs([]) })',
    "spawn('/usr/bin/open', ['-g', '-a', app, '--args', ...safeArgs(args)])",
  ])
    assert.deepEqual(checked(source), [true], source)
})

test('漏参数、散落的开关、无关位置调用 helper、条件分支漏项均拒绝', () => {
  for (const source of [
    'spawn(chrome, [])',
    "const unused = safeArgs([]); spawn(electron, ['main.mjs'])",
    "spawn(chrome, ['--use-mock-keychain', '--password-store=basic'])",
    'spawn(electron, packed ? safeArgs([]) : [])',
    'chromium.launch({ headless: true })',
    "spawn('/usr/bin/open', ['-g', '-a', app, '--args', ...args])",
    "spawn('/usr/bin/open', ['--args', ...safeArgs(args), '--password-store=keychain'])",
  ])
    assert.deepEqual(checked(source), [false], source)
})

test('新增脚本的自定义 CDP 二进制和 child_process 别名也受检查', () => {
  assert.deepEqual(checked("spawn(customBinary, ['--remote-debugging-port=0'])"), [false])
  assert.deepEqual(checked("import { spawn as run } from 'node:child_process'; run(chrome, [])"), [
    false,
  ])
  assert.deepEqual(checked("spawn(process.execPath, ['scripts/chrome-test.mjs'])"), [])
  assert.deepEqual(checked("execFileSync(process.env.LITCH_CHROME_GO, ['build'])"), [])
  assert.deepEqual(checked("import { chromium as engine } from 'playwright'; engine.launch({})"), [
    false,
  ])
  assert.deepEqual(checked("f.access.launch('ios')"), [])
})
