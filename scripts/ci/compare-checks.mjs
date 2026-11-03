// 对照只证明同 SHA 的命令和实际 Node 用例一致；平台条件分支仍须人工审阅，不自动改门禁。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { checkPlan, expectsNodeTests } from './check-catalog.mjs'
import { cliPackages } from './install-test-clis.mjs'

export function compareChecks(left, right, names, { only } = {}) {
  const expected = checkPlan(names)
  // 子集只从原始计划中选，不能改写失败报告的 complete 或伪造一份较短的来源计划。
  const selected = only ? checkPlan(only) : expected
  if (only) {
    assert.deepEqual(
      only,
      names.filter((name) => only.includes(name)),
      '子集不属于原始计划',
    )
    assert.ok(only.length < names.length, '完整计划不能用子集模式绕过 complete')
  }
  const ids = selected.checks.map((check) => check.id)
  const selectedResults = (proof) => proof.results.filter((result) => ids.includes(result.id))
  assert.deepEqual([left.platform, right.platform].sort(), ['darwin', 'linux'])
  for (const proof of [left, right]) {
    assert.equal(proof.schema, 1)
    assert.equal(typeof proof.complete, 'boolean')
    if (!only) assert.equal(proof.complete, true, '检查没有完整结束')
    assert.match(proof.sha, /^[a-f0-9]{40}$/)
    assert.ok(proof.repository && proof.runId && proof.attempt > 0, '没有云端来源')
    assert.deepEqual(proof.plan, expected, '检查清单或命令改变')
    const specs = cliPackages(proof.versions)
    assert.deepEqual(
      proof.clis,
      expected.clis.map((id) => ({ id, package: specs[id].name, version: specs[id].version })),
      'CLI清单或精确版本不同',
    )
    assert.deepEqual(
      proof.results.map((item) => item.id),
      expected.checks.slice(0, proof.results.length).map((item) => item.id),
      '原始结果必须是计划的连续执行前缀',
    )
    if (proof.complete) assert.equal(proof.results.length, expected.checks.length)
    assert.deepEqual(
      selectedResults(proof).map((item) => item.id),
      ids,
      '所选子集没有完整执行',
    )
    for (const result of selectedResults(proof)) {
      assert.equal(result.code, 0, `检查失败：${result.id}`)
      assert.equal(result.signal, null)
      assert.equal(
        result.tests.fail + result.tests.cancelled + result.tests.skipped,
        0,
        '失败/取消/跳过',
      )
      if (expectsNodeTests(result.id))
        assert.ok(result.tests.tests > 0 && result.tests.names.length > 0, '空Node用例集合')
    }
  }
  for (const field of ['repository', 'sha', 'runId', 'attempt', 'node', 'versions', 'clis'])
    assert.deepEqual(left[field], right[field], `对照来源不同：${field}`)
  const l = selectedResults(left)
  const r = selectedResults(right)
  for (let index = 0; index < l.length; index++)
    assert.deepEqual(l[index].tests, r[index].tests, `实际用例不同：${l[index].id}`)
  return {
    sha: left.sha,
    scope: only ? 'selected-subsets' : 'complete',
    sourceComplete: [left.complete, right.complete],
    suites: only ?? names,
    checks: selected.checks.length,
    nodeTests: l.reduce((sum, entry) => sum + entry.tests.tests, 0),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [left, right, ...names] = process.argv.slice(2)
  console.log(
    JSON.stringify(
      compareChecks(JSON.parse(readFileSync(left)), JSON.parse(readFileSync(right)), names),
    ),
  )
}
