import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 宿主带着模型凭据、代理和自己的 dsh 状态目录跑测试：预加载 setup 之后，用例和它起的 dsh 一样都看不到这些，
// 只剩系统变量、点名的测试开关和夹具给的假凭据。
test('测试环境只继承白名单：宿主凭据、代理、状态目录不进来，凭据换成测试用的', () => {
  const setup = fileURLToPath(new URL('./setup.mjs', import.meta.url))
  const fakeHost = {
    OPENROUTER_API_KEY: 'fake-host-openrouter',
    OPENAI_API_KEY: 'fake-host-openai',
    ANTHROPIC_API_KEY: 'fake-host-anthropic',
    DEEPSEEK_API_KEY: 'fake-host-deepseek',
    DEEPSEEK_BASE_URL: 'https://fake-host.invalid/anthropic',
    HTTPS_PROXY: 'http://fake-host.invalid:1',
    https_proxy: 'http://fake-host.invalid:1',
    NODE_OPTIONS: '--max-old-space-size=4096',
    CHA_DSH_HOME: '/fake-host/cha-dsh',
    DSH_HOME: '/fake-host/dsh-home',
    HOME: '/fake-host/home',
  }
  const printed = execFileSync(
    process.execPath,
    ['--import', setup, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    {
      env: {
        PATH: process.env.PATH,
        CHA_DSH_CLI: '/fake-host/bin/dsh',
        CHA_DSH_TRACE: '/fake-host/trace.jsonl',
        ...fakeHost,
      },
      encoding: 'utf8',
    },
  )
  const env: Record<string, string> = JSON.parse(printed)
  for (const name of Object.keys(env)) assert.doesNotMatch(env[name] as string, /fake-host-/, name)
  for (const name of [
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'HTTPS_PROXY',
    'https_proxy',
    'NODE_OPTIONS',
    'CHA_DSH_HOME',
  ])
    assert.equal(env[name], undefined, name)
  assert.equal(env.DEEPSEEK_API_KEY, 'mock-not-a-real-key')
  assert.match(env.DEEPSEEK_BASE_URL as string, /^http:\/\/127\.0\.0\.1:/)
  assert.notEqual(env.HOME, fakeHost.HOME)
  assert.ok(env.DSH_HOME?.startsWith(env.HOME as string), 'DSH_HOME 在临时 HOME 里')
  // 点名的测试开关照传
  assert.equal(env.CHA_DSH_CLI, '/fake-host/bin/dsh')
  assert.equal(env.CHA_DSH_TRACE, '/fake-host/trace.jsonl')
  assert.equal(env.PATH, process.env.PATH)
})
