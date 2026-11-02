// 对照只证明同 SHA 的命令和实际 Node 用例一致；平台条件分支仍须人工审阅，不自动改门禁。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { checkPlan, expectsNodeTests } from './check-catalog.mjs'
import { cliPackages } from './install-test-clis.mjs'

export function compareChecks(left, right, names) {
  const expected = checkPlan(names)
  assert.deepEqual([left.platform, right.platform].sort(), ['darwin', 'linux'])
  for (const proof of [left, right]) {
    assert.equal(proof.schema, 1)
    assert.equal(proof.complete, true, '检查没有完整结束')
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
      expected.checks.map((item) => item.id),
    )
    for (const result of proof.results) {
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
  for (let index = 0; index < left.results.length; index++)
    assert.deepEqual(
      left.results[index].tests,
      right.results[index].tests,
      `实际用例不同：${left.results[index].id}`,
    )
  return {
    sha: left.sha,
    suites: names,
    checks: expected.checks.length,
    nodeTests: left.results.reduce((sum, entry) => sum + entry.tests.tests, 0),
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
