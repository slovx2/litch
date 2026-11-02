// 检查身份与命令只在这里定义；准备依赖/CLI 属于调用方，不允许缺入口时跳过。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const npm = (id, script, prefix) => ({
  id,
  command: ['npm', 'run', script, ...(prefix ? ['--prefix', prefix] : [])],
})
const node = (id, file, ...args) => ({ id, command: ['node', file, ...args] })
const desktop = 'apps/desktop/scripts/'
export const expectsNodeTests = (id) =>
  id.includes(':test') ||
  id.endsWith(':unit') ||
  id.startsWith('client-fixture-') ||
  id === 'manager-fixture'

export const checks = [
  npm('client:typecheck', 'client:typecheck'),
  npm('client:test', 'client:test'),
  npm('client:test:ui', 'client:test:ui'),
  ...['browser', 'manual-skill', 'log-file', 'view-files', 'approvals', 'computer-use'].map(
    (name) => npm(`desktop:test:${name}`, `test:${name}`, 'apps/desktop'),
  ),
  node('smoke', `${desktop}smoke.mjs`),
  node('smoke:entry', `${desktop}smoke.mjs`, '--entry'),
  node('critical', `${desktop}smoke.mjs`, '--critical'),
  node('critical:entry', `${desktop}smoke.mjs`, '--critical', '--entry'),
  node(
    'first-turn',
    `${desktop}check-first-turn.mjs`,
    '--engines',
    'pi,codex,claude,dsh,opencode,acp',
  ),
  node('native-codex', 'scripts/check-native-codex.mjs'),
  node('client-tools-codex', 'scripts/check-client-tools-codex.mjs'),
  node('adapter', `${desktop}check-adapter.mjs`),
  node('client-fixture-anthropic', '--test', 'scripts/client-fixture-anthropic.test.mjs'),
  node('client-engines', `${desktop}check-engines.mjs`),
  npm('dsh:unit', 'test:dsh'),
  npm('dsh:ssh', 'test:dsh-ssh'),
  npm('opencode:unit', 'test:opencode'),
  node('background-client-tools', 'scripts/check-background-client-tools.mjs'),
  node('native-codex-background-wake', 'scripts/check-native-codex-background-wake.mjs'),
  node('restart-resume', 'scripts/check-restart-resume.mjs'),
  node('client-fixture-manager', '--test', 'scripts/client-fixture-manager.test.mjs'),
  node('manager-fixture', 'scripts/check-manager-fixture.mjs'),
]
const units = checks.slice(0, 9).map((check) => check.id)
export const suites = {
  'desktop-unit': { checks: units, desktopBuild: false, clis: [] },
  // 浏览器组包含真实 macOS Keychain/Node-API 测试，必须留在 Mac；原完整集合不缩减。
  'desktop-portable-unit': {
    checks: units.filter((id) => id !== 'desktop:test:browser'),
    desktopBuild: false,
    clis: [],
  },
  'desktop-required': {
    checks: [
      'smoke',
      'smoke:entry',
      'critical',
      'critical:entry',
      'first-turn',
      'native-codex',
      'client-tools-codex',
      'adapter',
    ],
    desktopBuild: true,
    clis: ['CODEX', 'CLAUDE', 'DSH', 'OPENCODE', 'ACP'],
  },
  'client-engines': {
    checks: ['client-fixture-anthropic', 'client-engines'],
    desktopBuild: true,
    clis: ['CLAUDE', 'DSH'],
  },
  'real-engines': {
    checks: [
      'first-turn',
      'native-codex',
      'client-tools-codex',
      'background-client-tools',
      'native-codex-background-wake',
      'restart-resume',
      'client-fixture-manager',
      'manager-fixture',
    ],
    desktopBuild: true,
    clis: ['CODEX', 'CLAUDE', 'DSH', 'OPENCODE', 'ACP'],
  },
  dsh: { checks: ['dsh:unit', 'dsh:ssh'], desktopBuild: false, clis: ['DSH'] },
  opencode: { checks: ['opencode:unit'], desktopBuild: false, clis: ['OPENCODE'] },
}

export function checkPlan(names) {
  assert.ok(Array.isArray(names) && names.length > 0, '必须指定非空检查集合')
  assert.equal(new Set(names).size, names.length, '重复领域')
  for (const name of names) assert.ok(Object.hasOwn(suites, name), `未知领域：${name}`)
  const selected = [...new Set(names.flatMap((name) => suites[name].checks))]
  const plan = {
    suites: names,
    checks: selected.map((id) => {
      const check = checks.find((entry) => entry.id === id)
      assert.ok(check, `缺检查定义：${id}`)
      return check
    }),
    desktopBuild: names.some((name) => suites[name].desktopBuild),
    clis: [...new Set(names.flatMap((name) => suites[name].clis))],
  }
  return { ...plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
}
