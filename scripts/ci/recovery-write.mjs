// 权限只暴露所需四种POST；不提供通用方法、发布、删制品或修改源码入口。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

export function githubWriter(execute = execFileSync) {
  return (path, body = {}) => {
    assert.match(
      path,
      /^repos\/slovx2\/litch\/(?:issues(?:\/\d+\/comments)?|actions\/jobs\/\d+\/rerun|actions\/runs\/\d+\/rerun-failed-jobs)$/,
    )
    let output
    try {
      output = execute('gh', ['api', '--method', 'POST', '--input', '-', '--include', path], {
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
    assert.match(headers, /^HTTP\/[\d.]+ 20[124]\b/)
    const text = output.slice(separator).trim()
    return text ? JSON.parse(text) : {}
  }
}
