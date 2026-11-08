// 单独运行的第二宿主原生夹具：不请求授权、不观察或输入用户应用。
// 先 npm run build --prefix packages/computer-use，再 node apps/computer-use/test-native-host.mjs。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  HelperSupervisor,
  MacLauncher,
} from '../../third_party/litch-automation/packages/computer-use/dist/computer-use/src/node.mjs'
import { buildHelper, signHelper } from './build-app.mjs'
import { validateHostIdentity } from './host-identity.mjs'

const root = mkdtempSync('/tmp/cu-host-')
const hostIdentity = validateHostIdentity({
  productName: 'Second Host',
  helperName: 'Second Computer Use',
  helperId: 'ai.example.second.computer-use',
  allowedPeerIds: ['ai.example.second'],
  protectedTargetIds: ['ai.example.second'],
  isolationEnvironmentKeys: ['SECOND_PROFILE'],
  directoryEnvironmentKey: 'SECOND_CU_DIR',
  tokenEnvironmentKey: 'SECOND_CU_TOKEN',
  defaultStateSubdirectory: 'Library/Application Support/Second/computer-use',
})
const app = buildHelper({
  out: root,
  hostIdentity,
  appName: 'Second Computer Use.app',
  executableName: 'SecondComputerUse',
  iconPath: null,
  version: '0.34.1',
})
signHelper(app)
const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8')
assert.ok(plist.includes('ai.example.second'))
assert.ok(!plist.includes('io.github.slovx2.litch'))
assert.equal(
  execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')],
    { encoding: 'utf8' },
  ).trim(),
  hostIdentity.helperId,
)
const supervisor = new HelperSupervisor({
  launcher: new MacLauncher({
    appPath: app,
    directory: join(root, 'run'),
    version: '0.34.1',
    identity: {
      helperId: hostIdentity.helperId,
      helperName: hostIdentity.helperName,
      executableName: 'SecondComputerUse',
      directoryEnv: hostIdentity.directoryEnvironmentKey,
      tokenEnv: hostIdentity.tokenEnvironmentKey,
    },
  }),
  lang: () => 'en',
})
let pid
try {
  const client = await supervisor.client()
  pid = client.hello.pid
  assert.equal(client.hello.bundleId, hostIdentity.helperId)
  assert.equal(realpathSync(client.hello.bundlePath), realpathSync(app))
  const diagnostics = await client.request('diagnostics')
  assert.equal(diagnostics.ppid, 1)
  assert.equal(diagnostics.responsibleIsSelf, true)
  await client.request('turnEnded', { session: 'second/fixture', turnId: 't' })
  console.log(`第二宿主独立身份/环境键/组件名/LaunchServices 握手通过；产物 ${root}`)
} finally {
  await supervisor.dispose()
}
assert.throws(() => process.kill(pid, 0))
console.log('第二宿主 helper 已退出；无系统授权请求、无用户应用输入')
