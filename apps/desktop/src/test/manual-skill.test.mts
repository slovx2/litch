// 产品手册注入（manual-skill.mts）的单元测试：全部在临时目录里当主目录，不碰真实的 ~/.agents、~/.claude。
// 手册的源用仓库里的 skills/litch-manual（由 scripts/test-manual-skill.mjs 经 LITCH_MANUAL_SOURCE 给）。
//   node scripts/test-manual-skill.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import type { ManualStatus } from '../manual-ipc.mjs'
import {
  createManualSkill,
  inspectManual,
  installManual,
  MANUAL_MARKER,
  type ManualInstall,
  manualEntity,
  removeManual,
} from '../manual-skill.mjs'
import { readPreferences } from '../preferences.mjs'

const source = process.env.LITCH_MANUAL_SOURCE ?? ''
let root = ''
let home = ''

beforeEach(() => {
  assert.ok(existsSync(join(source, 'SKILL.md')), `手册的源不对：${source}`)
  root = mkdtempSync(join(tmpdir(), 'litch-manual-test-'))
  home = join(root, 'home')
  mkdirSync(home)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 一个假的适配器：路径里带空格和 $，把收到的参数一行一个打出来 */
function fakeAdapter(): string {
  const dir = join(root, 'My Apps', 'Litch $HOME')
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'codex-harness-adapter')
  writeFileSync(bin, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n', {
    mode: 0o755,
  })
  return bin
}

function options(extra: Partial<ManualInstall> = {}): ManualInstall {
  return {
    home,
    env: {},
    platform: 'darwin',
    source,
    adapterBin: '/Applications/Litch.app/Contents/Resources/adapter/bin/codex-harness-adapter',
    version: '1.2.3',
    ...extra,
  }
}

const stateOf = (status: ManualStatus, harness: string) =>
  status.targets.find((target) => target.harness === harness)

test('首次安装：实体带记号，Claude 的目录里是链接，没有的配置目录跳过', () => {
  mkdirSync(join(home, '.claude'))
  const status = installManual(options())
  const entity = join(home, '.agents', 'skills', 'litch-manual')
  assert.equal(status.error, undefined)
  assert.equal(status.dir, entity)
  assert.equal(status.version, '1.2.3')
  assert.equal(readFileSync(join(entity, MANUAL_MARKER), 'utf8'), '1.2.3\n')
  assert.ok(existsSync(join(entity, 'SKILL.md')))
  assert.ok(existsSync(join(entity, 'references', 'devices.md')))
  for (const harness of ['codex', 'pi', 'opencode', 'dsh', 'gemini']) {
    assert.deepEqual(stateOf(status, harness), { harness, path: entity, state: 'installed' })
  }
  const link = join(home, '.claude', 'skills', 'litch-manual')
  assert.equal(stateOf(status, 'claude-code')?.state, 'linked')
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), entity)
  // 没有 ~/.qwen：跳过，也不替它建
  assert.equal(stateOf(status, 'qwen')?.state, 'skipped')
  assert.match(stateOf(status, 'qwen')?.reason ?? '', /\.qwen does not exist/)
  assert.ok(!existsSync(join(home, '.qwen')))
  assert.ok(readFileSync(join(entity, 'SKILL.md'), 'utf8').startsWith('---\nname: litch-manual\n'))
})

test('命令壳：写进适配器的绝对路径，带空格和 $ 也能原样把参数交过去', () => {
  const bin = fakeAdapter()
  installManual(options({ adapterBin: bin }))
  const entity = manualEntity({ home, env: {}, platform: 'darwin' })
  const shell = join(entity, 'scripts', 'litch')
  assert.equal(statSync(shell).mode & 0o777, 0o755)
  assert.ok(!readFileSync(shell, 'utf8').includes('{{ADAPTER}}'))
  const out = execFileSync(shell, ['devices', 'add', '--name', 'a b', '--json'], {
    encoding: 'utf8',
  })
  assert.equal(out, 'config\ndevices\nadd\n--name\na b\n--json\n')
  const cmd = readFileSync(join(entity, 'scripts', 'litch.cmd'), 'utf8')
  assert.ok(cmd.includes(`"${bin}" config %*\r\n`))
})

test('升级：整份换掉（旧文件不留），记号和壳里的路径跟着新的', () => {
  mkdirSync(join(home, '.claude'))
  installManual(options())
  const entity = manualEntity({ home, env: {}, platform: 'darwin' })
  writeFileSync(join(entity, 'references', 'stale.md'), 'old\n')
  const status = installManual(options({ version: '2.0.0', adapterBin: '/new/place/adapter' }))
  assert.equal(status.error, undefined)
  assert.equal(readFileSync(join(entity, MANUAL_MARKER), 'utf8'), '2.0.0\n')
  assert.ok(!existsSync(join(entity, 'references', 'stale.md')))
  assert.ok(
    readFileSync(join(entity, 'scripts', 'litch'), 'utf8').includes(
      'exec "/new/place/adapter" config',
    ),
  )
  assert.equal(stateOf(status, 'claude-code')?.state, 'linked')
  // 换的过程中用的临时目录都收掉了
  const leftovers = execFileSync('ls', ['-A', join(home, '.agents')], { encoding: 'utf8' })
  assert.equal(leftovers.trim(), 'skills')
})

test('foreign：别人的同名目录和链接不碰', () => {
  mkdirSync(join(home, '.claude', 'skills', 'litch-manual'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'litch-manual', 'SKILL.md'), 'mine\n')
  const status = installManual(options())
  assert.equal(stateOf(status, 'claude-code')?.state, 'foreign')
  assert.equal(
    readFileSync(join(home, '.claude', 'skills', 'litch-manual', 'SKILL.md'), 'utf8'),
    'mine\n',
  )
  // 关掉时也不碰
  const removed = removeManual({ home, env: {}, platform: 'darwin', version: '1.2.3' })
  assert.equal(stateOf(removed, 'claude-code')?.state, 'foreign')
  assert.ok(existsSync(join(home, '.claude', 'skills', 'litch-manual', 'SKILL.md')))
  assert.equal(stateOf(removed, 'codex')?.state, 'removed')
})

test('foreign：实体的位置被用户占着就整件不做，别处跳过', () => {
  mkdirSync(join(home, '.claude'))
  const entity = join(home, '.agents', 'skills', 'litch-manual')
  mkdirSync(entity, { recursive: true })
  writeFileSync(join(entity, 'SKILL.md'), 'mine\n')
  const status = installManual(options())
  assert.equal(status.dir, null)
  assert.match(status.error ?? '', /leaves it alone/)
  assert.equal(stateOf(status, 'codex')?.state, 'foreign')
  assert.equal(stateOf(status, 'claude-code')?.state, 'skipped')
  assert.equal(readFileSync(join(entity, 'SKILL.md'), 'utf8'), 'mine\n')
  assert.ok(!existsSync(join(home, '.claude', 'skills')))
})

test('父目录不存在：不建 ~/.claude，跳过并说明', () => {
  const status = installManual(options())
  assert.equal(stateOf(status, 'claude-code')?.state, 'skipped')
  assert.match(stateOf(status, 'claude-code')?.reason ?? '', /~\/\.claude does not exist/)
  assert.ok(!existsSync(join(home, '.claude')))
})

test('关掉：删掉带记号的实体和指向它的链接，~/.agents/skills 本身留着', () => {
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, '.qwen'))
  installManual(options())
  const status = removeManual({ home, env: {}, platform: 'darwin', version: '1.2.3' })
  assert.equal(status.enabled, false)
  assert.equal(status.error, undefined)
  for (const harness of ['codex', 'claude-code', 'qwen']) {
    assert.equal(stateOf(status, harness)?.state, 'removed', harness)
  }
  assert.ok(!existsSync(join(home, '.agents', 'skills', 'litch-manual')))
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'litch-manual')))
  assert.ok(!existsSync(join(home, '.qwen', 'skills', 'litch-manual')))
  assert.ok(existsSync(join(home, '.agents', 'skills')))
  // 再关一次：都是没装
  const again = removeManual({ home, env: {}, platform: 'darwin', version: '1.2.3' })
  assert.equal(stateOf(again, 'codex')?.state, 'skipped')
})

test('环境变量：CLAUDE_CONFIG_DIR 换 Claude 的目录，DSH_AGENTS_HOME 指回 ~/.agents 时并成一处', () => {
  const claude = join(root, 'claude-config')
  mkdirSync(claude)
  const status = installManual(
    options({ env: { CLAUDE_CONFIG_DIR: claude, DSH_AGENTS_HOME: join(home, '.agents') } }),
  )
  const entity = manualEntity({ home, env: {}, platform: 'darwin' })
  assert.equal(stateOf(status, 'claude-code')?.path, join(claude, 'skills', 'litch-manual'))
  assert.equal(stateOf(status, 'claude-code')?.state, 'linked')
  assert.deepEqual(stateOf(status, 'dsh'), { harness: 'dsh', path: entity, state: 'installed' })
  assert.equal(status.targets.filter((target) => target.harness === 'dsh').length, 1)
})

test('Windows：不建链接，复制一份带记号的；两个壳里的路径各按各的写法', () => {
  mkdirSync(join(home, '.claude'))
  const bin =
    'C:\\Users\\me\\AppData\\Local\\Litch\\resources\\adapter\\bin\\codex-harness-adapter.exe'
  const status = installManual(options({ platform: 'win32', adapterBin: bin }))
  const copy = join(home, '.claude', 'skills', 'litch-manual')
  assert.equal(stateOf(status, 'claude-code')?.state, 'installed')
  assert.ok(lstatSync(copy).isDirectory())
  assert.equal(readFileSync(join(copy, MANUAL_MARKER), 'utf8'), '1.2.3\n')
  assert.ok(readFileSync(join(copy, 'scripts', 'litch.cmd'), 'utf8').includes(`"${bin}" config %*`))
  assert.ok(
    readFileSync(join(copy, 'scripts', 'litch'), 'utf8').includes(
      'exec "C:/Users/me/AppData/Local/Litch/resources/adapter/bin/codex-harness-adapter.exe" config "$@"',
    ),
  )
  // 关掉时副本也认得出来
  const removed = removeManual({ home, env: {}, platform: 'win32', version: '1.2.3' })
  assert.equal(stateOf(removed, 'claude-code')?.state, 'removed')
  assert.ok(!existsSync(copy))
})

test('上次装到一半留下的临时目录会被收掉', () => {
  const left = join(home, '.agents', '.litch-manual-123-abcd')
  mkdirSync(join(left, 'scripts'), { recursive: true })
  installManual(options())
  assert.ok(!existsSync(left))
})

test('只看不动：inspectManual 报现状', () => {
  mkdirSync(join(home, '.claude'))
  installManual(options())
  const status = inspectManual({
    home,
    env: {},
    platform: 'darwin',
    version: '1.2.3',
    enabled: true,
  })
  assert.equal(status.dir, join(home, '.agents', 'skills', 'litch-manual'))
  assert.equal(stateOf(status, 'claude-code')?.state, 'linked')
  assert.equal(stateOf(status, 'codex')?.state, 'installed')
  assert.equal(stateOf(status, 'qwen')?.reason, '~/.qwen does not exist')
})

test('主进程那一份：开关默认开、关掉写进偏好并删除、没有适配器时说明原因', async () => {
  mkdirSync(join(home, '.claude'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  const common = {
    dataDir,
    version: '1.2.3',
    platform: 'darwin' as const,
    home,
    environment: async () => null,
    log: () => {},
  }
  const skill = createManualSkill({ ...common, source, adapterBin: '/x/adapter' })
  skill.start()
  const first = await skill.status()
  assert.equal(first.enabled, true)
  assert.equal(first.dir, join(home, '.agents', 'skills', 'litch-manual'))
  const off = await skill.setEnabled(false)
  assert.equal(off.enabled, false)
  assert.equal(readPreferences(dataDir).manualSkill, false)
  assert.ok(!existsSync(join(home, '.agents', 'skills', 'litch-manual')))
  // 重启后关着：只看不装
  const later = createManualSkill({ ...common, source, adapterBin: '/x/adapter' })
  later.start()
  assert.equal((await later.status()).enabled, false)
  assert.ok(!existsSync(join(home, '.agents', 'skills', 'litch-manual')))
  const on = await later.setEnabled(true)
  assert.equal(on.enabled, true)
  assert.ok(existsSync(join(home, '.agents', 'skills', 'litch-manual', 'SKILL.md')))
  // 没有内置适配器的运行：不装，说原因
  rmSync(join(dataDir, 'preferences.json'))
  const bare = createManualSkill({
    ...common,
    source: null,
    adapterBin: null,
    reason: 'Self-check runs do not install the manual',
  })
  const status = await bare.status()
  assert.equal(status.error, 'Self-check runs do not install the manual')
})
