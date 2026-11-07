import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  AccountQuota,
  emptyQuota,
  parseQuota,
  type QuotaSnapshot,
  queryQuota,
} from '../src/account-limits.mjs'

// 按 agy 1.5.2 只读响应的形状构造；数值与模型名是测试数据，不含真实账号内容。
const bucket = (id: string, window: string, remaining_fraction: number | null) => ({
  id,
  window,
  remaining_fraction,
  reset_time: '2026-11-14T05:02:54Z',
})
const payload = (
  buckets: unknown[] = [bucket('gemini-weekly', 'weekly', 0.72), bucket('gemini-5h', '5h', 0.25)],
) => ({
  status: 'SUCCESS',
  response: '不解析这段展示文本',
  usage: { total_tokens: 99999 },
  command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets }] } },
})

test('只取结构化订阅额度，短窗口在前、剩余比例转已用百分比、时间转秒', () => {
  const result = parseQuota(payload())
  assert.deepEqual(result.rateLimits, emptyQuota().rateLimits)
  assert.deepEqual(Object.keys(result.rateLimitsByLimitId), ['agy:gemini-5h', 'agy:gemini-weekly'])
  assert.deepEqual(result.rateLimitsByLimitId['agy:gemini-5h']?.primary, {
    usedPercent: 75,
    windowDurationMins: 300,
    resetsAt: Date.parse('2026-11-14T05:02:54Z') / 1000,
  })
  assert.equal(result.rateLimitsByLimitId['agy:gemini-weekly']?.primary?.usedPercent, 28)
  assert.equal(result.rateLimitsByLimitId['agy:gemini-weekly']?.limitName, 'Gemini Models')
})

test('不把缺失、禁用或非法额度画成 0；未知窗口保留官方名称、不猜重置时间', () => {
  const result = parseQuota(
    payload([
      bucket('zero', '5h', 0),
      bucket('full', 'weekly', 1),
      bucket('missing', '5h', null),
      bucket('bad', '5h', NaN),
      bucket('large', '5h', 2),
      bucket('negative', '5h', -1),
      { ...bucket('disabled', '5h', 1), disabled: true },
      { ...bucket('future', 'custom', 0.1234), name: 'Special quota', reset_time: 'invalid' },
    ]),
  )
  assert.deepEqual(Object.keys(result.rateLimitsByLimitId), ['agy:zero', 'agy:full', 'agy:future'])
  assert.equal(result.rateLimitsByLimitId['agy:zero']?.primary?.usedPercent, 100)
  assert.equal(result.rateLimitsByLimitId['agy:full']?.primary?.usedPercent, 0)
  assert.equal(result.rateLimitsByLimitId['agy:future']?.limitName, 'Gemini Models · Special quota')
  assert.deepEqual(result.rateLimitsByLimitId['agy:future']?.primary, {
    usedPercent: 88,
    windowDurationMins: null,
    resetsAt: null,
  })
  for (const value of [null, {}, { ...payload(), status: 'ERROR' }, { command: { name: 'other' } }])
    assert.deepEqual(parseQuota(value), emptyQuota())
})

test('按需读、并发合并、30 秒缓存；有额度才在回合后刷新，失败清除旧值', async () => {
  let now = 1000,
    reads = 0,
    fail = false
  const events: QuotaSnapshot[] = []
  const quota = new AccountQuota(
    async () => {
      reads++
      if (fail) throw new Error('不应进入协议的原始错误')
      return payload()
    },
    (value) => events.push(value),
    () => now,
  )
  quota.afterTurn()
  assert.equal(reads, 0)
  await Promise.all([quota.read(), quota.read()])
  assert.equal(reads, 1)
  quota.afterTurn()
  await quota.read()
  assert.equal(reads, 1)
  now += 30_000
  quota.afterTurn()
  await quota.read()
  assert.equal(reads, 2)
  fail = true
  now += 30_000
  quota.afterTurn()
  assert.deepEqual(await quota.read(), emptyQuota())
  assert.ok(events.slice(-2).every((value) => value.primary === null && value.secondary === null))
  now += 30_000
  quota.afterTurn()
  assert.equal(reads, 3, '失败后不在每个回合重试；下一次主动查看再试')
  quota.close()
})

test('退出登录或关闭时取消查询，晚到的旧账号结果不能恢复显示', async () => {
  let finish!: (value: unknown) => void
  let signal!: AbortSignal
  const events: QuotaSnapshot[] = []
  const quota = new AccountQuota(
    (current) => {
      signal = current
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    (value) => events.push(value),
  )
  const reading = quota.read()
  await Promise.resolve()
  quota.invalidate()
  assert.equal(signal.aborted, true)
  finish(payload())
  assert.deepEqual(await reading, emptyQuota())
  assert.deepEqual(events, [])
  quota.close()
  assert.deepEqual(await quota.read(), emptyQuota())
})

test('独立 CLI 查询只发送固定只读参数，隔离工作目录；错误、非法输出和取消静默', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-quota-cli-'))
  const script = join(home, 'fake-agy.mjs')
  const env = {
    HOME: home,
    USERPROFILE: home,
    CHA_AGY_CLI: script,
    GEMINI_API_KEY: 'fake-key',
    GOOGLE_API_KEY: 'fake-key',
  }
  try {
    await writeFile(
      script,
      `
      import assert from 'node:assert/strict';
      import { realpathSync } from 'node:fs';
      assert.deepEqual(process.argv.slice(2), ['-p', '/usage', '--output-format', 'json']);
      assert.equal(realpathSync(process.cwd()), realpathSync(process.env.HOME));
      assert.equal(process.env.GEMINI_API_KEY, undefined);
      assert.equal(process.env.GOOGLE_API_KEY, undefined);
      process.stdout.write(${JSON.stringify(JSON.stringify(payload()))});
    `,
    )
    await chmod(script, 0o700)
    const query = () => queryQuota(home, env, new AbortController().signal)
    assert.deepEqual(parseQuota(await query()), parseQuota(payload()))
    assert.equal(
      await queryQuota(
        home,
        { ...env, CHA_AGY_ARGS: 'acp --app-data-dir other' },
        new AbortController().signal,
      ),
      null,
    )
    await writeFile(script, 'process.stderr.write("secret"); process.stdout.write("bad json");')
    assert.equal(await query(), null)
    await writeFile(script, 'process.stdout.write("secret"); process.exit(1);')
    assert.equal(await query(), null)
    await writeFile(script, 'process.stdout.write("x".repeat(2 * 1024 * 1024));')
    assert.equal(await query(), null)
    await writeFile(script, 'setInterval(() => {}, 1000);')
    const controller = new AbortController()
    const running = queryQuota(home, env, controller.signal)
    controller.abort()
    assert.equal(await running, null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
