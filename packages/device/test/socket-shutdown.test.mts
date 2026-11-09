import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isolatedEnv } from '../../claude/test/fixtures/isolated-env.mjs'

test('目录监听断言失败后回收所有原始连接，保留断言并让进程自行退出', async () => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./fixtures/layer-watch-failure.mjs', import.meta.url)),
      '--test',
      '--test-isolation=none',
      '--test-reporter=spec',
      '--test-name-pattern=经真的套接字',
      fileURLToPath(new URL('./device-layer.test.mjs', import.meta.url)),
    ],
    { env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  // 回归失败也只杀自己的子进程。禁用测试进程隔离，避免杀掉 runner 后留下孙进程。
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 10_000)
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      },
    )
    assert.equal(timedOut, false, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.code, 1, output)
    assert.equal(output.match(/raw socket connected/g)?.length, 3, output)
    assert.match(output, /AssertionError.*目录监听一直没有通知/s)
    assert.doesNotMatch(output, /test timed out|cancelled [1-9]/)
  } finally {
    clearTimeout(timer)
  }
})
