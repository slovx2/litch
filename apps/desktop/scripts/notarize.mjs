import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// 只提交一次，不将 Rejected/Invalid 或超时重新提交成另一单。
export function notarize(file, credentials, spawn = spawnSync) {
  console.log(`公证 ${basename(file)}（最多等待 30 分钟）`)
  const submitted = spawn(
    'xcrun',
    [
      'notarytool',
      'submit',
      file,
      ...credentials,
      '--wait',
      '--timeout',
      '30m',
      '--output-format',
      'json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 35 * 60_000 },
  )
  let result
  try {
    result = JSON.parse(submitted.stdout)
  } catch {}
  if (submitted.status === 0 && result?.status === 'Accepted') return result.id
  if (result?.id) {
    spawn('xcrun', ['notarytool', 'log', result.id, ...credentials], {
      stdio: 'inherit',
      timeout: 60_000,
    })
  }
  throw new Error(`${basename(file)} 没有通过公证：${result?.status ?? '没有有效结果'}；不重试提交`)
}

export function isStaplerNetworkFailure(result) {
  if (result.status === 0 || result.status == null || result.error || result.signal) return false
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (output.includes('LITCH_PF_CLEANUP_FAILED')) return false
  // 只在 stapler 的原始输出中识别已确认的网络故障，不能只凭进程退出码判断。
  return /NSURLErrorDomain[^\r\n]*-1005\b/.test(output) || /\bError\s+68\b/i.test(output)
}

function recordStaplerFailure(file, operation, attempt, result, summary) {
  if (!summary) return
  const output = `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`
  const longest = Math.max(0, ...[...output.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  appendFileSync(
    summary,
    `\n### stapler ${operation}：${basename(file)}，第 ${attempt} 次失败\n\n` +
      `退出码：${result.status ?? '无'}；信号：${result.signal ?? '无'}；` +
      `执行错误：${result.error?.message ?? '无'}\n\n${fence}text\n${output}\n${fence}\n`,
  )
}

// 只恢复明确的 Apple 票据网络故障。validate 重试不重做 staple，更不重新提交公证。
export function staple(file, spawn = spawnSync, options = {}) {
  for (const operation of ['staple', 'validate']) {
    staplerCommand(operation, file, spawn, options)
  }
}

export function validateTicket(file, spawn = spawnSync, options = {}) {
  staplerCommand('validate', file, spawn, options)
}

function staplerCommand(
  operation,
  file,
  spawn,
  { summary = process.env.GITHUB_STEP_SUMMARY, tcp = process.env.LITCH_STAPLER_TCP === '1' } = {},
) {
  // ARM 托管 runner 对照满足启用条件；仅票据命令临时阻断 UDP443，退出立即撤销。
  // 两台 ARM 样本：默认网络 -1005 为 1/31，TCP 为 0/32；不是零故障保证，保留三次重试。
  // 复核数据：https://github.com/slovx2/litch/actions/runs/41514458534（attempt 3、4）。
  // https://github.com/actions/runner-images/issues/14924
  const command = tcp ? 'bash' : 'xcrun'
  const args = tcp
    ? [
        fileURLToPath(new URL('../../../scripts/ci/stapler-tcp.sh', import.meta.url)),
        operation,
        file,
      ]
    : ['stapler', operation, file]
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawn(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: tcp ? 90_000 : 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.status === 0) break
    recordStaplerFailure(file, operation, attempt, result, summary)
    if (attempt === 3 || !isStaplerNetworkFailure(result)) {
      throw new Error(
        `${basename(file)} 的 stapler ${operation} 第 ${attempt} 次失败；不分发未通过钉票校验的包`,
      )
    }
    const waited = spawn('sleep', [String(attempt * 30)], { stdio: 'inherit' })
    if (waited.status !== 0) throw new Error('stapler 退避被中断；停止重试')
  }
}
