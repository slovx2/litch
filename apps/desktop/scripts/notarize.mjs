import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

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

// 票据传播可能稍晚；三次总等待 45 秒，每次命令还有自身超时。
export function staple(file, spawn = spawnSync) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawn('xcrun', ['stapler', 'staple', file], {
      stdio: 'inherit',
      timeout: 60_000,
    })
    if (result.status === 0) {
      const checked = spawn('xcrun', ['stapler', 'validate', file], {
        stdio: 'inherit',
        timeout: 60_000,
      })
      if (checked.status !== 0) throw new Error(`${basename(file)} 的 staple 校验失败`)
      return
    }
    if (attempt < 3) spawn('sleep', [String(attempt * 15)])
  }
  throw new Error(`${basename(file)} 三次 staple 都失败；不分发未钉票的包`)
}
