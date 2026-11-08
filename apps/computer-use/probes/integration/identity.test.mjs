// 真套接字与协议帧验证启动合同，不拉起应用、不读取或请求系统权限。
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  fileHash,
  probeSigningPlan,
  reusableBuild,
  signingRequirement,
  sourceFingerprint,
} from './build-contract.mjs'
import { PROBE_IDENTITY } from './identity.mjs'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.endsWith('.mjs')) throw error
      return next(specifier.replace(/\.mjs$/, '.mts'), context)
    }
  },
})
const { MacLauncher } = await import(
  '../../../../third_party/litch-automation/packages/computer-use/src/launcher-mac.mts'
)
const { MacLauncher: ProductLauncher } = await import(
  '../../../desktop/src/computer-use/launcher-mac.mts'
)
const { encodeFrame, FrameReader, HELPER_PROTOCOL } = await import(
  '../../../../third_party/litch-automation/packages/computer-use/src/wire.mts'
)

const probePath = '/Apps/Litch Background Input Probe.app'
const productId = 'io.github.slovx2.litch.computer-use'
test('专用测试证书可选；未设置时保留原有显式签名，设置无效值不能回退', () => {
  assert.deepEqual(probeSigningPlan(undefined, 'existing Developer ID'), {
    identity: 'existing Developer ID',
    requirement: null,
    timestamp: '--timestamp',
  })
  assert.throws(() => probeSigningPlan(undefined, undefined))
  assert.throws(() => probeSigningPlan('', 'existing Developer ID'))
})
test('只接受测试专用证书；要求不依赖二进制 cdhash', () => {
  const sha = 'A'.repeat(40)
  const inventory = `  1) ${sha} "Litch CU Probe Local"`
  const requirement = signingRequirement(sha.toLowerCase(), inventory)
  assert.equal(
    requirement,
    `identifier "${PROBE_IDENTITY.helperId}" and certificate leaf = H"${sha}"`,
  )
  for (const identity of [undefined, '-', 'Developer ID Application', 'Litch CU Probe Local'])
    assert.throws(() => signingRequirement(identity, inventory))
  assert.throws(() => signingRequirement(sha, `  1) ${sha} "Developer ID Application: Product"`))
  assert.throws(() => signingRequirement('B'.repeat(40), inventory))
})

test('相同输入复用；源码、签名、模式或产物变化必须重建', () => {
  const root = mkdtempSync('/tmp/litch-cu-build-')
  try {
    const source = join(root, 'main.swift')
    writeFileSync(source, 'first')
    const inputs = [{ path: source }]
    const config = { requirement: 'certificate A', coexist: false }
    const fingerprint = sourceFingerprint(inputs, config)
    assert.equal(sourceFingerprint(inputs, config), fingerprint)
    mkdirSync(join(root, 'another-worktree'))
    const anotherSource = join(root, 'another-worktree/main.swift')
    writeFileSync(anotherSource, 'first')
    assert.equal(sourceFingerprint([{ path: anotherSource }], config), fingerprint)
    assert.notEqual(sourceFingerprint(inputs, { ...config, coexist: true }), fingerprint)
    assert.notEqual(
      sourceFingerprint(inputs, { ...config, requirement: 'certificate B' }),
      fingerprint,
    )
    writeFileSync(source, 'second')
    assert.notEqual(sourceFingerprint(inputs, config), fingerprint)
    const app = join(root, 'Probe.app')
    const executable = join(app, 'Contents/MacOS', PROBE_IDENTITY.executableName)
    const plist = join(app, 'Contents/Info.plist')
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
    writeFileSync(executable, 'binary')
    writeFileSync(plist, 'plist')
    const record = join(root, 'build.json')
    assert.equal(reusableBuild(record, fingerprint, app), false)
    writeFileSync(
      record,
      JSON.stringify({ fingerprint, executable: fileHash(executable), plist: fileHash(plist) }),
    )
    assert.equal(reusableBuild(record, fingerprint, app), true)
    assert.equal(reusableBuild(record, 'changed', app), false)
    writeFileSync(executable, 'changed binary')
    assert.equal(reusableBuild(record, fingerprint, app), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const scenario of [
  { name: '探针身份可握手', bundleId: PROBE_IDENTITY.helperId, accepts: true },
  { name: '探针启动器拒绝正式助手', bundleId: productId, accepts: false },
  { name: '探针启动器拒绝其他路径', bundleId: PROBE_IDENTITY.helperId, wrongPath: true },
  { name: '生产包装器仍拒绝探针身份', bundleId: PROBE_IDENTITY.helperId, product: true },
]) {
  test(scenario.name, async () => {
    const directory = mkdtempSync('/tmp/litch-cu-identity-')
    const sockets = new Set()
    let token
    let helloCount = 0
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      const reader = new FrameReader()
      socket.on('data', (data) => {
        reader.push(data)
        for (let frame = reader.next(); frame !== undefined; frame = reader.next()) {
          assert.equal(frame.method, 'hello')
          assert.equal(frame.params.protocol, HELPER_PROTOCOL)
          assert.equal(frame.params.token, token)
          assert.equal(frame.params.lang, 'zh-CN')
          helloCount++
          socket.write(
            encodeFrame({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                protocol: HELPER_PROTOCOL,
                pid: process.pid,
                version: '1',
                bundleId: scenario.bundleId,
                bundlePath: scenario.wrongPath ? '/Other/Probe.app' : probePath,
                auth: 'token',
                teamId: null,
              },
            }),
          )
        }
      })
    })
    const Launcher = scenario.product ? ProductLauncher : MacLauncher
    const launcher = new Launcher({
      identity: PROBE_IDENTITY,
      appPath: probePath,
      directory,
      version: null,
      async launch(appPath, env) {
        assert.equal(appPath, probePath)
        assert.deepEqual(Object.keys(env).sort(), [
          'LITCH_COMPUTER_USE_DIR',
          'LITCH_COMPUTER_USE_TOKEN',
        ])
        assert.equal(env.LITCH_COMPUTER_USE_DIR, directory)
        assert.match(env.LITCH_COMPUTER_USE_TOKEN, /^[0-9a-f]{64}$/)
        token = env.LITCH_COMPUTER_USE_TOKEN
        server.listen(join(directory, 'helper.sock'))
        await once(server, 'listening')
      },
    })
    try {
      if (scenario.accepts) {
        const client = await launcher.establish('zh-CN', () => {})
        assert.equal(client.hello.bundleId, PROBE_IDENTITY.helperId)
        client.close()
      } else {
        await assert.rejects(
          launcher.establish('zh-CN', () => {}),
          /identity, path or version/,
        )
      }
      assert.equal(helloCount, 1)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
