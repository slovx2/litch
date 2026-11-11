// 发版和运行报告共用的小页查询；只恢复服务端和网络故障，不放宽来源校验。
import { setTimeout as delay } from 'node:timers/promises'

const pageSize = 30
const maxAttempts = 5
const budgetMs = 180_000
const networkCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

function networkError(error) {
  return (
    error?.name === 'TimeoutError' ||
    // 此查询只使用自己的超时信号；响应体读取超时由 fetch 表达为 AbortError。
    error?.name === 'AbortError' ||
    networkCodes.has(error?.code) ||
    (error?.cause && networkError(error.cause)) ||
    (error instanceof AggregateError && error.errors.some(networkError))
  )
}

export async function readJobs(
  path,
  {
    request = fetch,
    sleep = delay,
    now = Date.now,
    log = console.error,
    apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  } = {},
) {
  const deadline = now() + budgetMs
  const jobs = []
  for (let page = 1; ; page++) {
    const url = new URL(`${apiUrl.replace(/\/$/, '')}/${path}`)
    url.searchParams.set('per_page', String(pageSize))
    url.searchParams.set('page', String(page))
    let result
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error(`读取 jobs 超过3分钟：${path}，第${page}页`)
      try {
        const response = await request(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(Math.min(30_000, remaining)),
        })
        if (!response.ok) {
          // 读取失败响应也释放连接；错误正文不进入日志，避免泄露凭据。
          await response.body?.cancel().catch(() => {})
          throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
        }
        result = await response.json()
        if (!Array.isArray(result.jobs)) throw new Error('响应缺少 jobs 数组')
        break
      } catch (error) {
        const retryable = (error.status >= 500 && error.status < 600) || networkError(error)
        const waitMs = 1000 * 2 ** (attempt - 1)
        const retry = retryable && attempt < maxAttempts && now() + waitMs < deadline
        log(
          `读取 jobs 失败：${path}，第${page}页，尝试${attempt}/${maxAttempts}，${error.message}；${retry ? `${waitMs}ms后重试` : '停止'}`,
        )
        if (!retry)
          throw new Error(`读取 jobs 失败：${path}，第${page}页，${error.message}`, {
            cause: error,
          })
        await sleep(waitMs)
      }
    }
    jobs.push(...result.jobs)
    if (result.jobs.length < pageSize) return jobs
  }
}
