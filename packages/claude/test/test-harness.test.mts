import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isolatedEnv } from './fixtures/isolated-env.mjs'

const cases = fileURLToPath(new URL('./fixtures/harness-cases.mjs', import.meta.url))

// 另起一个测试进程跑指定的情形；它必须自己退出，到时限还在就算挂住。
async function runCase(name: string, home: string, env: NodeJS.ProcessEnv, flags: string[] = []) {
  const child = spawn(
    process.execPath,
    ['--test', ...flags, `--test-name-pattern=${name}`, cases],
    // 独立进程组：挂住时连同它派生的测试进程和被测进程一起结束。
    { env: { ...isolatedEnv, ...env, HARNESS_CASE_HOME: home }, detached: true },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  const started = Date.now()
  let hung = false
  const limit = setTimeout(() => {
    hung = true
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
  }, 30_000)
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
  clearTimeout(limit)
  assert.equal(hung, false, `测试进程 30 秒没有退出:\n${output}`)
  return { code, output, elapsed: Date.now() - started }
}

test('HARNESS-001：用例超时卡住时测试文件仍会退出，被测进程被回收', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'test-harness-hang-'))
  try {
    const { code, output } = await runCase('卡在等不到的事件上', home, {})
    assert.equal(code, 1, output)
    const adapter = Number(await readFile(join(home, 'adapter.pid'), 'utf8'))
    assert.throws(() => process.kill(adapter, 0), { code: 'ESRCH' }, '适配器进程不能留下')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('HARNESS-002：用例留下监听端口后失败，按 npm test 的参数运行时测试文件仍会退出', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'test-harness-port-'))
  try {
    const manifest = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    )
    assert.match(manifest.scripts.test, / --test-force-exit /, 'npm test 必须带强制退出')
    const { code, output } = await runCase('留下监听端口后失败', home, {}, ['--test-force-exit'])
    assert.equal(code, 1, output)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('HARNESS-003：没有指定隔离 CLI 时真实 CLI 用例立即失败，不改用 PATH 里的 claude', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'test-harness-cli-'))
  try {
    // PATH 最前面放一个假的 claude，被执行就留下记号。
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'claude'), `#!/bin/sh\ntouch "${join(home, 'claude-ran')}"\n`)
    await chmod(join(bin, 'claude'), 0o755)
    const { code, output, elapsed } = await runCase('没有指定隔离 CLI', home, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CHA_CLAUDE_CLI: undefined,
    })
    assert.equal(code, 1, output)
    assert.match(output, /CHA_CLAUDE_CLI/)
    assert.ok(elapsed < 15_000, `应立即失败，实际用了 ${elapsed} 毫秒`)
    await assert.rejects(readFile(join(home, 'claude-ran')), { code: 'ENOENT' })
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
