// 只接受已完成双平台对照的集合；JSON 不进入 shell，不接受临时命令或跳过参数。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { checkPlan } from './check-catalog.mjs'

export function linuxSuites(value) {
  const names = JSON.parse(value)
  const allowed = ['desktop-portable-unit', 'desktop-required', 'real-engine-tools', 'real-engines']
  checkPlan(names)
  assert.ok(
    names.every((name) => allowed.includes(name)),
    '没有Linux等价证据的检查集合',
  )
  return names
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = linuxSuites(process.env.CHECK_SUITES)
  const mode = process.argv[2]
  assert.ok(['install', 'run'].includes(mode), '未知执行模式')
  const script = mode === 'install' ? 'install-test-clis.mjs' : 'run-checks.mjs'
  const result = spawnSync(process.execPath, [`scripts/ci/${script}`, ...names], {
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
