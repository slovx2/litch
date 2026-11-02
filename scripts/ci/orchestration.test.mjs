// 编排回归：不启动真实模拟器/CLI、不访问个人配置，不把测试假结果当成真实 E2E。
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { mobileShards } from './mobile-shards.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = (name) => join(repo, 'scripts/ci', name)
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'litch-ci-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function executable(path, code) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!${process.execPath}\n${code}`, { mode: 0o755 })
}

test('手机全部 flow 恰好分配一次，每片九条，预估耗时均衡', () => {
  const flows = join(repo, 'apps/mobile/e2e/flows')
  const expected = ['mock', 'fixture']
    .flatMap((group) =>
      readdirSync(join(flows, group))
        .filter((file) => file.endsWith('.yaml'))
        .map((file) => join(flows, group, file)),
    )
    .sort()
  const shards = mobileShards(flows)
  assert.equal(expected.length, 27)
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), expected)
  assert.deepEqual(
    shards.map((shard) => shard.files.length),
    [9, 9, 9],
  )
  const seconds = shards.map((shard) => shard.seconds)
  assert.ok(Math.max(...seconds) - Math.min(...seconds) < 40)
})

test('新增 flow 自动纳入，不受历史耗时名单限制', (t) => {
  const flows = temporary(t)
  for (const group of ['mock', 'fixture']) mkdirSync(join(flows, group))
  for (let n = 1; n <= 25; n++)
    writeFileSync(join(flows, 'mock', `${String(n).padStart(2, '0')}-flow.yaml`), '')
  const files = mobileShards(flows).flatMap((shard) => shard.files)
  assert.equal(new Set(files).size, 25)
})

test('APK 封存/验证通过，篡改 APK、源码或构建输出都失败', (t) => {
  const directory = temporary(t)
  const source = join(directory, 'input.apk')
  const output = join(directory, 'artifact')
  writeFileSync(source, '唯一 APK')
  const run = (mode, env = {}) =>
    spawnSync(process.execPath, [script('apk.mjs'), mode, output, source], {
      cwd: repo,
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
      encoding: 'utf8',
    })
  assert.equal(run('seal').status, 0)
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')))
  const expected = { EXPECTED_SOURCE_SHA: manifest.sha, EXPECTED_APK_HASH: manifest.hash }
  assert.equal(run('verify', expected).status, 0)
  assert.notEqual(run('verify', { ...expected, EXPECTED_SOURCE_SHA: 'wrong' }).status, 0)
  assert.notEqual(run('verify', { ...expected, EXPECTED_APK_HASH: 'wrong' }).status, 0)
  writeFileSync(join(output, 'app-release.apk'), '另一份 APK')
  assert.notEqual(run('verify', expected).status, 0)
  assert.equal(manifest.hash, createHash('sha256').update('唯一 APK').digest('hex'))
})

test('文件分片不漏不重，独立 HOME；失败退出码不吞掉', (t) => {
  const directory = temporary(t)
  const tests = join(directory, 'packages/claude/dist/claude/test')
  mkdirSync(join(tests, 'fixtures'), { recursive: true })
  writeFileSync(join(tests, 'fixtures/isolate-process.mjs'), '')
  for (const name of ['a', 'b', 'c', 'd']) {
    writeFileSync(
      join(tests, `${name}.mjs`),
      `import assert from 'node:assert/strict';
      assert.notEqual(process.env.HOME, process.env.ORIGINAL_HOME);
      assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
      console.log('HOME=' + process.env.HOME);
      if ('${name}' === process.env.FAIL_FILE) throw new Error('预期失败');`,
    )
  }
  const run = (shard, fail = '') =>
    spawnSync(process.execPath, [script('test-shard.mjs'), 'claude', shard], {
      cwd: directory,
      env: {
        ...process.env,
        ORIGINAL_HOME: process.env.HOME,
        ANTHROPIC_API_KEY: 'fake',
        FAIL_FILE: fail,
      },
      encoding: 'utf8',
    })
  const first = run('1/2')
  const second = run('2/2')
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.match(first.stdout, /test\/a\.mjs\n.*test\/c\.mjs/)
  assert.match(second.stdout, /test\/b\.mjs\n.*test\/d\.mjs/)
  assert.notEqual(first.stdout.match(/HOME=(.+)/)[1], second.stdout.match(/HOME=(.+)/)[1])
  assert.notEqual(run('1/2', 'a').status, 0)
  assert.notEqual(run('3/2').status, 0)
})

test('运行汇总保留 attempt 1 首败，即使 attempt 2 通过', async (t) => {
  const directory = temporary(t)
  const summary = join(directory, 'summary.md')
  const server = createServer((req, res) => {
    const first = req.url.includes('/attempts/1/')
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        jobs: [
          {
            name: 'mobile (1)',
            steps: [
              {
                name: 'Maestro',
                conclusion: first ? 'failure' : 'success',
                started_at: '2026-11-02T00:00:00Z',
                completed_at: '2026-11-02T00:00:12Z',
              },
            ],
          },
        ],
      }),
    )
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  await promisify(execFile)(process.execPath, [script('run-summary.mjs')], {
    env: {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: 'fake/repo',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_TOKEN: 'fake',
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  const text = readFileSync(summary, 'utf8')
  assert.match(text, /Attempt 1（首轮）[\s\S]*首次失败：mobile \(1\) \/ Maestro/)
  assert.match(text, /Attempt 2（人工\/外部重跑）[\s\S]*首次失败：无/)
  assert.match(text, /failure \| 12/)
})

test('外部下载只重试已识别的瞬态错误，404 立即失败且逐次记账', (t) => {
  const directory = temporary(t)
  const count = join(directory, 'count')
  const summary = join(directory, 'summary.md')
  executable(
    join(directory, 'curl'),
    `
    const fs = require('node:fs');
    const count = fs.existsSync(process.env.CURL_COUNT) ? Number(fs.readFileSync(process.env.CURL_COUNT)) + 1 : 1;
    fs.writeFileSync(process.env.CURL_COUNT, String(count));
    const code = process.env.CURL_FAILURE === '502' && count > 1 ? 200 : Number(process.env.CURL_FAILURE);
    console.log(code);
    process.exit(code === 200 ? 0 : 22);`,
  )
  const run = (failure) =>
    spawnSync(
      process.execPath,
      [script('download.mjs'), 'fake', 'https://example.invalid/file', join(directory, 'file')],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CURL_COUNT: count,
          CURL_FAILURE: failure,
          GITHUB_STEP_SUMMARY: summary,
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    )
  assert.notEqual(run('404').status, 0)
  assert.equal(readFileSync(count, 'utf8'), '1')
  writeFileSync(count, '0')
  assert.equal(run('502').status, 0)
  assert.equal(readFileSync(count, 'utf8'), '2')
  assert.match(readFileSync(summary, 'utf8'), /尝试 1，退出码 22，HTTP 502/)
  assert.match(readFileSync(summary, 'utf8'), /尝试 2，退出码 0，HTTP 200/)
})

test('只读缓存能收尾，且不跟随符号链接修改片外目录', (t) => {
  const directory = temporary(t)
  const tests = join(directory, 'packages/device/dist/device/test')
  const outside = join(directory, 'outside')
  const recorded = join(directory, 'test-home')
  mkdirSync(tests, { recursive: true })
  mkdirSync(outside, { mode: 0o555 })
  writeFileSync(
    join(tests, 'cache.test.mjs'),
    `
    import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
    import { join } from 'node:path';
    const cache = join(process.env.HOME, 'go/pkg/mod/module@1');
    mkdirSync(cache, {recursive:true});
    writeFileSync(join(cache,'go.mod'), 'module fake');
    chmodSync(cache, 0o555);
    symlinkSync(process.env.OUTSIDE, join(process.env.HOME, 'outside'));
    writeFileSync(process.env.RECORDED, process.env.HOME);
  `,
  )
  const result = spawnSync(process.execPath, [script('test-shard.mjs'), 'device'], {
    cwd: directory,
    env: { ...process.env, OUTSIDE: outside, RECORDED: recorded },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(readFileSync(recorded, 'utf8')), false)
  assert.equal(statSync(outside).mode & 0o777, 0o555)
})
