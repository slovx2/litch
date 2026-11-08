// 原生隔离探针握手验收：关闭鼠标自测，仅 hello/shutdown，不需要辅助功能或录屏授权。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import {
  MacLauncher,
  PROBE_IDENTITY,
  probeAppPath,
} from '../../.artifacts/integration/remote-driver.mjs'

const root = mkdtempSync('/tmp/litch-cu-handshake-')
for (const name of ['home', 'codex']) mkdirSync(join(root, name), { mode: 0o700 })
const launcher = new MacLauncher({
  identity: PROBE_IDENTITY,
  appPath: probeAppPath(),
  directory: join(root, 'helper'),
  version: null,
  async launch(appPath, env) {
    execFileSync('/usr/bin/open', [
      '-n',
      '-g',
      '-a',
      appPath,
      ...Object.entries({
        ...env,
        HOME: join(root, 'home'),
        CODEX_HOME: join(root, 'codex'),
        LITCH_CU_PROBE_NO_PRIVATE: '1',
      }).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ])
  },
})
const client = await launcher.establish('zh-CN', console.log)
try {
  assert.equal(client.hello.bundleId, PROBE_IDENTITY.helperId)
  assert.equal(client.hello.auth, 'token')
  console.log(JSON.stringify({ directory: root, hello: client.hello }, null, 2))
} finally {
  try {
    await client.request('shutdown')
  } finally {
    client.close()
    await launcher.afterShutdown()
  }
}
