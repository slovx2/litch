// 真正的 Go 生命周期、Node 设备入口和本机/代理套接字，GitHub 只在隔离子进程中重定向到回环。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TestClient } from '../packages/device/dist/packages/device/test/helpers.mjs'
import { owner, scenario } from './external-github-mock.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

test('本机设备服务：系统自启状态、私有配置、受限代理和停机重连', { timeout: 55_000 }, async (t) => {
  const home = mkdtempSync('/tmp/lg-device-')
  const socket = join(home, 'device', 'device.sock')
  const { origin } = await scenario(t, { now: Math.floor(Date.now() / 1000) })
  const shim = join(home, 'mock-github.mjs')
  writeFileSync(
    shim,
    `
const origin = ${JSON.stringify(origin)}
const real = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input)
  if (url.origin === 'https://api.github.com') return real(new URL(url.pathname + url.search, origin), init)
  if (url.origin === origin) return real(input, init)
  throw new Error('External network disabled for fixture')
}
`,
  )
  const env = {
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_OPTIONS: `--import=${shim}`,
    CHA_LANG: 'en',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const cli = (args) =>
    exec(
      join(root, 'bin', 'codex-harness-adapter'),
      [...args, '--home', home, '--root', root, '--node', process.execPath],
      { env, timeout: 30_000 },
    )
  let local
  let remote
  const stop = async () => {
    local?.close()
    remote?.close()
    await cli(['device-stop'])
  }
  t.after(async () => {
    await stop()
    rmSync(home, { recursive: true, force: true })
  })
  const start = async () => {
    try {
      const started = await cli(['device-start', '--ssh=off'])
      assert.equal(JSON.parse(started.stdout).ready, true)
    } catch (error) {
      let logs = ''
      try {
        logs = readFileSync(join(home, 'logs', 'device.log'), 'utf8')
      } catch {}
      throw new Error(`隔离设备未就绪：${logs}`, { cause: error })
    }
    const extensions = ['harness', 'litchExternalSources', 'litchDeviceAutostart']
    local = await TestClient.overSocket(socket)
    remote = await TestClient.overSocket(`${socket}.r`)
    await Promise.all([local.initialize(extensions), remote.initialize(extensions)])
  }
  await start()
  const status = await local.call('litch/device/autostart/get', {})
  assert.equal(status.state, 'disabled')
  assert.equal(status.serviceManager, process.platform === 'darwin' ? 'launchd' : 'systemd')
  const direct = await cli(['device-autostart', 'get'])
  assert.equal(JSON.parse(direct.stdout).state, status.state)
  assert.equal(
    (
      await remote.fails('litch/device/autostart/enable', {
        operationId: 'forbidden',
        expectedRevision: 0,
      })
    ).code,
    -32600,
  )
  await local.call('litch/external/owner/set', {
    expectedRevision: 0,
    operationId: 'owner-1',
    owner: {
      provider: 'github',
      userId: owner,
      loginCache: 'owner',
      profileUrl: 'https://github.com/owner',
      method: 'userId',
    },
  })
  assert.equal((await remote.call('litch/external/access/get', {})).pauseSource, false)
  await stop()
  await start()
  assert.equal((await local.call('litch/external/owner/get', {})).owner.userId, owner)
})
