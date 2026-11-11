// 只使用注入的请求和虚拟时钟，不连接 GitHub 或继承个人认证。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readJobs } from './release-jobs.mjs'

const path = 'repos/fake/repo/actions/runs/42/attempts/3/jobs'
const response = (jobs) => Response.json({ jobs })
const fullPage = (start) => Array.from({ length: 30 }, (_, i) => ({ id: start + i }))

function fixture(request) {
  let elapsed = 0
  const calls = []
  const waits = []
  const logs = []
  return {
    calls,
    waits,
    logs,
    advance: (ms) => {
      elapsed += ms
    },
    options: {
      apiUrl: 'https://api.example.invalid',
      token: 'fake-token',
      now: () => elapsed,
      sleep: async (ms) => {
        waits.push(ms)
        elapsed += ms
      },
      log: (message) => logs.push(message),
      request: async (url, options) => {
        assert.equal(url.origin, 'https://api.example.invalid')
        assert.equal(url.searchParams.get('per_page'), '30')
        assert.equal(options.headers.Authorization, 'Bearer fake-token')
        calls.push(url.href)
        return request(url, calls.length, options)
      },
    },
  }
}

test('连续两次502后成功，指数退避且保留失败记录', async () => {
  const f = fixture((_url, n) =>
    n <= 2 ? new Response('', { status: 502 }) : response([{ id: 1 }]),
  )
  assert.deepEqual(await readJobs(path, f.options), [{ id: 1 }])
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.waits, [1000, 2000])
  assert.equal(new Set(f.calls).size, 1)
  assert.equal(f.logs.length, 2)
  assert.ok(f.logs.every((line) => /HTTP 502/.test(line)))
  assert.doesNotMatch(f.logs.join('\n'), /fake-token/)
})

test('5xx最多请求5次，耗尽后暴露最终错误而非返回空jobs', async () => {
  const f = fixture(() => new Response('', { status: 503 }))
  await assert.rejects(readJobs(path, f.options), (error) => {
    assert.match(error.message, /第1页，HTTP 503/)
    assert.equal(error.cause.status, 503)
    return true
  })
  assert.equal(f.calls.length, 5)
  assert.deepEqual(f.waits, [1000, 2000, 4000, 8000])
  assert.equal(f.logs.length, 5)
  assert.match(f.logs.at(-1), /尝试5\/5.*停止/)
})

test('401、403、404、429立即失败，不盲重试', async () => {
  for (const status of [401, 403, 404, 429]) {
    const f = fixture(() => new Response('', { status }))
    await assert.rejects(readJobs(path, f.options), new RegExp(`HTTP ${status}`))
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.waits, [])
    assert.equal(f.logs.length, 1)
  }
})

test('聚合所有页，保留filter、attempt、顺序和完整job字段，当前页失败不重复前页', async () => {
  const pages = [fullPage(1), fullPage(31), [{ id: 61, run_attempt: 2, conclusion: 'failure' }]]
  const f = fixture((url, n) => {
    assert.equal(url.pathname, '/repos/fake/repo/actions/runs/42/attempts/3/jobs')
    assert.equal(url.searchParams.get('filter'), 'latest')
    if (n === 2) return new Response('', { status: 502 })
    return response(pages[Number(url.searchParams.get('page')) - 1])
  })
  const jobs = await readJobs(`${path}?filter=latest&per_page=100&page=99`, f.options)
  assert.deepEqual(jobs, pages.flat())
  assert.deepEqual(
    f.calls.map((url) => new URL(url).searchParams.get('page')),
    ['1', '2', '2', '3'],
  )
})

test('满30条后继续读取空尾页；后页失败不能返回不完整列表', async () => {
  const f = fixture((url) => response(url.searchParams.get('page') === '1' ? fullPage(1) : []))
  assert.deepEqual(await readJobs(path, f.options), fullPage(1))
  assert.equal(f.calls.length, 2)
  const broken = fixture((url) =>
    url.searchParams.get('page') === '1'
      ? response(fullPage(1))
      : new Response('', { status: 404 }),
  )
  await assert.rejects(readJobs(path, broken.options), /第2页，HTTP 404/)
  assert.equal(broken.calls.length, 2)
})

test('连接中断、读取响应体中断和请求超时均可有界恢复', async () => {
  const reset = new TypeError('fetch failed', {
    cause: Object.assign(new Error(), { code: 'ECONNRESET' }),
  })
  const timeout = new DOMException('request timed out', 'TimeoutError')
  for (const failure of [reset, timeout]) {
    const f = fixture((_url, n) => {
      if (n <= 2) throw failure
      return response([])
    })
    assert.deepEqual(await readJobs(path, f.options), [])
    assert.equal(f.calls.length, 3)
    assert.deepEqual(f.waits, [1000, 2000])
  }
  for (const failure of [reset, new DOMException('body aborted', 'AbortError')]) {
    const body = fixture((_url, n) => ({
      ok: true,
      json: async () => {
        if (n === 1) throw failure
        return { jobs: [] }
      },
    }))
    assert.deepEqual(await readJobs(path, body.options), [])
    assert.deepEqual(body.waits, [1000])
  }
  const exhausted = fixture(() => {
    throw reset
  })
  await assert.rejects(readJobs(path, exhausted.options), /fetch failed/)
  assert.equal(exhausted.calls.length, 5)
})

test('JSON、结构和未知本地错误不当成网络故障重试', async () => {
  for (const request of [
    () => new Response('{invalid'),
    () => Response.json({ wrong: [] }),
    () => {
      throw new Error('本地配置错误')
    },
  ]) {
    const f = fixture(request)
    await assert.rejects(readJobs(path, f.options))
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.waits, [])
  }
})

test('整个分页查询共享3分钟预算，包含请求耗时与退避，不返回部分结果', async () => {
  const f = fixture((_url, _n, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    f.advance(30_000)
    return response(fullPage(1))
  })
  await assert.rejects(readJobs(path, f.options), /超过3分钟.*第7页/)
  assert.equal(f.calls.length, 6)
  const limited = fixture((_url, n) => {
    limited.advance(n === 1 ? 178_000 : 1000)
    return new Response('', { status: 502 })
  })
  await assert.rejects(readJobs(path, limited.options), /HTTP 502/)
  assert.equal(limited.calls.length, 2)
  assert.deepEqual(limited.waits, [1000])
})
