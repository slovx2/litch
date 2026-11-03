// 除原恢复POST，仅增加固定灰色标签和关闭审计issue；不提供通用PATCH或发布入口。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

export function githubWriter(execute = execFileSync) {
  return (path, body = {}, method = 'POST') => {
    if (method === 'PATCH') {
      assert.match(path, /^repos\/slovx2\/litch\/issues\/[1-9]\d*$/)
      assert.deepEqual(body, { state: 'closed' })
    } else {
      assert.equal(method, 'POST')
      assert.match(
        path,
        /^repos\/slovx2\/litch\/(?:labels|issues(?:\/\d+\/comments)?|actions\/jobs\/\d+\/rerun|actions\/runs\/\d+\/rerun-failed-jobs)$/,
      )
      if (path.endsWith('/labels'))
        assert.deepEqual(body, {
          name: 'ci-recovery',
          color: 'ededed',
          description: 'CI基础设施恢复审计；关闭不释放预算',
        })
    }
    let output
    try {
      output = execute('gh', ['api', '--method', method, '--input', '-', '--include', path], {
        input: JSON.stringify(body),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      // 超时或403都不自动重试POST；调用方以已占用预算只读核实。
      throw new Error('GitHub写入结果未确认，禁止盲目重试')
    }
    const separator = output.search(/\r?\n\r?\n/)
    assert.ok(separator > 0, 'API响应头缺失')
    const headers = output.slice(0, separator)
    assert.match(headers, /^HTTP\/[\d.]+ 20[0124]\b/)
    const text = output.slice(separator).trim()
    return text ? JSON.parse(text) : {}
  }
}
