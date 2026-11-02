// 只有已识别的外部下载瞬态错误可重试，每次结果立即写 summary，校验摘要由调用方负责。
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

const [name, url, destination] = process.argv.slice(2)
if (!name || !url?.startsWith('https://') || !destination)
  throw new Error('用法：download.mjs 名称 https://URL 文件')
for (let attempt = 1; attempt <= 4; attempt++) {
  const start = Date.now()
  const result = spawnSync(
    'curl',
    [
      '--fail',
      '--location',
      '--connect-timeout',
      '30',
      '--max-time',
      '300',
      '--write-out',
      '%{http_code}',
      '--output',
      destination,
      url,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const status = Number(result.stdout?.trim())
  const message = `${name} 下载：尝试 ${attempt}，退出码 ${result.status}，HTTP ${status}，${((Date.now() - start) / 1000).toFixed(1)} 秒，已重试 ${attempt - 1} 次。`
  console.log(message)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
  if (result.error) throw result.error
  if (result.status === 0) break
  if (
    attempt === 4 ||
    !(
      [408, 429, 500, 502, 503, 504].includes(status) ||
      [5, 6, 7, 18, 28, 35, 52, 56, 92].includes(result.status)
    )
  ) {
    throw new Error(`${name} 下载失败，不再重试`)
  }
  await setTimeout(3000 * attempt)
}
