import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { nightlyChecks } from '../../apps/desktop/scripts/nightly-checks.mjs'
import { domains as fullDomains } from '../ci-impact.mjs'
import { cliPackages } from './install-test-clis.mjs'
import { iosReadiness } from './ios-checks.mjs'

export function nativeCliVersions(selected) {
  const versions = JSON.parse(
    readFileSync(new URL('../../protocol/versions.json', import.meta.url)),
  )
  const specs = cliPackages(versions)
  return (
    selected.some((name) => ['client-engines', 'adapters'].includes(name)) ? ['CLAUDE', 'DSH'] : []
  ).map((id) => ({
    id,
    package: specs[id].name,
    version: specs[id].version,
  }))
}

export const nativeDomains = [
  'browser',
  'computer-use',
  'client',
  'client-engines',
  'adapters',
  'ios',
]
export function selectedNative(domains, runCi) {
  const selected = domains.trim() ? JSON.parse(domains) : fullDomains
  assert.ok(Array.isArray(selected) && selected.every((name) => fullDomains.includes(name)))
  return nativeDomains.filter((name) =>
    name === 'browser'
      ? runCi
      : name === 'ios'
        ? selected.includes('mobile')
        : selected.includes(name),
  )
}

export function nativePlan(selected) {
  assert.ok(Array.isArray(selected) && selected.length > 0, 'Mac集合不能为空')
  assert.equal(new Set(selected).size, selected.length)
  assert.ok(
    selected.every((name) => nativeDomains.includes(name)),
    '未知Mac领域',
  )
  const checks = []
  const add = (id, command) => checks.push({ id, command })
  if (selected.includes('adapters'))
    add('adapters:macos', ['node', 'scripts/ci/mac-adapter-checks.mjs'])
  if (selected.includes('ios')) add('ios:build-unit', ['node', 'scripts/ci/ios-checks.mjs'])
  if (selected.includes('browser'))
    add('browser', ['npm', 'run', 'test:browser', '--prefix', 'apps/desktop'])
  if (selected.includes('computer-use')) {
    add('computer-use:swift', ['swift', 'test', '--package-path', 'apps/computer-use'])
    add('computer-use:unit', ['npm', 'run', 'test:computer-use', '--prefix', 'apps/desktop'])
    add('computer-use:native', ['node', 'apps/desktop/scripts/check-computer-use.mjs'])
  }
  if (selected.includes('client')) {
    add('client:diagnostics', ['node', '--test', 'scripts/chrome-m0/diagnostics.test.mjs'])
    for (const [id, ...args] of nightlyChecks) add(`client:${id}`, ['node', ...args])
  }
  if (selected.includes('client-engines')) {
    add('client-engines:fixture', ['node', '--test', 'scripts/client-fixture-anthropic.test.mjs'])
    add('client-engines:windows', ['node', 'apps/desktop/scripts/check-engines.mjs'])
  }
  return { domains: nativeDomains.filter((name) => selected.includes(name)), checks }
}

export function checkNativeProof(proof, selected, context) {
  const plan = nativePlan(selected)
  assert.equal(proof?.schema, 1)
  for (const field of ['repository', 'sha', 'workflowSha', 'runId', 'attempt']) {
    assert.equal(proof[field], context[field], `Mac证明${field}不符`)
  }
  assert.equal(proof.platform, 'darwin')
  assert.equal(proof.arch, 'arm64')
  assert.equal(proof.complete, true, 'Mac检查未全部完成')
  if (selected.includes('ios')) assert.deepEqual(proof.ios, iosReadiness(), 'iOS构建范围不符')
  assert.deepEqual(proof.plan, plan, 'Mac检查计划不符')
  assert.deepEqual(proof.clis, nativeCliVersions(selected), 'Mac隔离CLI版本不符')
  assert.deepEqual(
    proof.results.map((item) => item.id),
    plan.checks.map((item) => item.id),
  )
  for (const result of proof.results) {
    assert.equal(result.code, 0, `Mac检查失败：${result.id}`)
    assert.equal(result.signal, null)
  }
  return proof
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selected = selectedNative(
    process.env.FULL_DOMAINS ?? '',
    process.env.FULL_RUN_CI !== 'false',
  )
  appendFileSync(process.env.GITHUB_OUTPUT, `domains=${JSON.stringify(selected)}\n`)
}
