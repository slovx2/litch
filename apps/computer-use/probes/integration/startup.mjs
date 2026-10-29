// 冷启动只读权限与能力，不操作用户应用；明细在助手日志中。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MacLauncher } from '../../.artifacts/integration/remote-driver.mjs'

const root = process.argv[2]
if (!root?.startsWith('/tmp/litch-cu-')) throw new Error('需要隔离目录')
mkdirSync(root, { recursive: true })
const results = []
for (let i = 0; i < 3; i++) {
  const directory = join(root, String(i))
  const appPath = resolve(
    'apps/computer-use/.artifacts/integration/Litch Background Input Probe.app',
  )
  const launcher = new MacLauncher({
    appPath,
    directory,
    version: null,
    async launch(path, env) {
      execFileSync('open', [
        '-n',
        '-g',
        ...Object.entries({
          ...env,
          HOME: join(root, 'home'),
          CODEX_HOME: join(root, 'codex'),
        }).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        path,
      ])
    },
  })
  const client = await launcher.establish('zh-CN', console.log)
  try {
    const permissions = await client.request('permissions')
    const diagnostics = await client.request('diagnostics')
    const immediate = await client.request('backgroundCapabilities')
    assert.equal(permissions.accessibility, true)
    assert.equal(diagnostics.responsibleIsSelf, true)
    if (process.argv[3]) {
      assert.ok(process.argv[3].startsWith('/tmp/litch-cu-'))
      const audit = JSON.parse(readFileSync(join(directory, 'foreground.json'), 'utf8'))
      assert.ok(audit.idle >= 2 && Date.now() / 1000 - audit.sampledAt < 0.5)
      assert.notEqual(audit.frontBundle, 'com.apple.loginwindow')
      const fixture = JSON.parse(readFileSync(join(process.argv[3], 'appkit/state.json'), 'utf8'))
      process.kill(fixture.pid, 0)
      const params = { session: 'startup', app: 'io.github.slovx2.litch.background-fixture' }
      const shot = await client.request('getAppState', params)
      const point = fixture.points.button
      await client.request('click', {
        ...params,
        x: ((point.x - fixture.frame.x) * shot.screenshot.width) / fixture.frame.width,
        y: ((point.y - fixture.frame.y) * shot.screenshot.height) / fixture.frame.height,
      })
      await client.request('turnEnded', { session: 'startup' })
    }
    await delay(1000)
    const settled = await client.request('backgroundCapabilities')
    results.push({
      permissions,
      diagnostics,
      immediate,
      settled,
      log: readFileSync(join(directory, 'helper.log'), 'utf8'),
    })
  } finally {
    await client.request('shutdown')
    client.close()
    await delay(300)
  }
}
writeFileSync(join(root, 'report.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
assert.ok(
  results.every((row) => row.settled.mouse === 'available'),
  '启动自测应通过；失败明细已保存',
)
