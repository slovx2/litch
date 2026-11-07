// 本机真实 Squirrel 验收。独立 bundle id、签名测试应用、隔离 HOME/profile；只退出、不重开。
// LITCH_SIGN_IDENTITY='Developer ID Application: …' node apps/desktop/scripts/check-updater-mac.mjs
// 不公证、不发布，不控制正式 Litch；产物与 evidence 留在 .artifacts/update-latest/mac/。
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sign } from '@electron/osx-sign'
import { packager } from '@electron/packager'
import { build } from 'esbuild'

if (process.platform !== 'darwin' || !process.env.LITCH_SIGN_IDENTITY)
  throw new Error('需要 macOS 与 LITCH_SIGN_IDENTITY')
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const root = join(repo, '.artifacts/update-latest/mac', randomUUID())
const source = join(root, 'source')
mkdirSync(source, { recursive: true })
const identifier = `dev.litch.updater-probe-${randomUUID()}`
const name = 'LitchUpdateProbe'
const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' })
writeFileSync(
  join(source, 'package.json'),
  JSON.stringify({ name, version: '1.0.0', main: 'main.mjs', type: 'module' }),
)
await build({
  entryPoints: [join(repo, 'apps/desktop/scripts/updater-mac-probe.mts')],
  outfile: join(source, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron'],
  alias: { '@litch/core': join(repo, 'packages/core/src/index.mts') },
})
const version = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8'))
  .devDependencies.electron
const [packed] = await packager({
  dir: source,
  out: join(root, 'packed'),
  name,
  platform: 'darwin',
  arch: 'arm64',
  appBundleId: identifier,
  appVersion: '1.0.0',
  electronVersion: version,
  asar: false,
})
const base = join(packed, `${name}.app`)
const signed = async (app) => {
  await sign({
    app,
    identity: process.env.LITCH_SIGN_IDENTITY,
    platform: 'darwin',
    type: 'distribution',
    hardenedRuntime: true,
    preAutoEntitlements: false,
    optionsForFile: () => ({
      entitlements: join(repo, 'apps/desktop/packaging/node.entitlements.plist'),
      // 隔离验收包不发布，不依赖在线时间戳服务。
      timestamp: 'none',
    }),
  })
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
}
const mark = (app, version) => {
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set:CFBundleShortVersionString ${version}`,
    join(app, 'Contents/Info.plist'),
  ])
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set:CFBundleVersion ${version}`,
    join(app, 'Contents/Info.plist'),
  ])
  writeFileSync(join(app, 'Contents/Resources/update-marker'), version)
  const manifest = join(app, 'Contents/Resources/app/package.json')
  writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version }),
  )
}
for (const version of ['1.0.1', '1.0.2']) {
  const bundle = join(root, version, `${name}.app`)
  run('/usr/bin/ditto', [base, bundle])
  mark(bundle, version)
  await signed(bundle)
  run('/usr/bin/ditto', [
    '-c',
    '-k',
    '--zlibCompressionLevel',
    '0',
    '--keepParent',
    bundle,
    join(root, `${version}.zip`),
  ])
  if (version === '1.0.2') {
    writeFileSync(join(bundle, 'Contents/Resources/update-marker'), '签名故意损坏')
    run('/usr/bin/ditto', [
      '-c',
      '-k',
      '--zlibCompressionLevel',
      '0',
      '--keepParent',
      bundle,
      join(root, 'invalid.zip'),
    ])
  }
}
mark(base, '1.0.0')
await signed(base)
const label = `${identifier}.ShipIt`
const caches = new Set([join(homedir(), 'Library/Caches', label)])
const clean = () => {
  try {
    run('/bin/launchctl', ['remove', label])
  } catch {}
  for (const path of caches) rmSync(path, { recursive: true, force: true })
}
const results = []
try {
  for (const scenario of ['success', 'failure']) {
    const directory = join(root, scenario)
    const app = join(directory, `${name}.app`)
    const profile = join(directory, 'profile')
    const home = join(directory, 'home')
    mkdirSync(profile, { recursive: true })
    mkdirSync(home, { recursive: true })
    caches.add(join(home, 'Library/Caches', label))
    run('/usr/bin/ditto', [base, app])
    const log = []
    const child = spawn(join(app, `Contents/MacOS/${name}`), [], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        LITCH_PROFILE: profile,
        LITCH_MOCK: '1',
        LITCH_ADAPTER_ROOT: '',
        LITCH_UPDATE_PROBE: JSON.stringify({ root, profile, identifier, scenario }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (text) => {
      log.push(String(text))
      process.stdout.write(text)
    })
    child.stderr.on('data', (text) => {
      log.push(String(text))
      process.stderr.write(text)
    })
    const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000)
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    clearTimeout(timeout)
    writeFileSync(join(directory, 'process.log'), log.join(''))
    const evidence = JSON.parse(readFileSync(join(profile, 'evidence.json'), 'utf8'))
    caches.add(join(evidence.home, 'Library/Caches', label))
    assert.equal(evidence.ok, true, JSON.stringify(evidence))
    const expected = scenario === 'success' ? '1.0.2' : '1.0.1'
    const marker = join(app, 'Contents/Resources/update-marker')
    let complete = false
    for (let attempt = 0; attempt < 120; attempt++) {
      // ShipIt 可能逐项替换 Contents；标记文件出现不等于整份应用已安装完成。
      if (existsSync(marker) && readFileSync(marker, 'utf8') === expected) {
        complete =
          spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {
            stdio: 'ignore',
          }).status === 0
        if (complete) break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(complete, true, '等待真实 ShipIt 完整安装超时')
    assert.equal(readFileSync(marker, 'utf8'), expected, '真实 ShipIt 未装上期望版本')
    assert.equal(
      JSON.parse(readFileSync(join(app, 'Contents/Resources/app/package.json'), 'utf8')).version,
      expected,
    )
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    results.push({ scenario, installed: expected, evidence: join(profile, 'evidence.json') })
    for (const path of caches) {
      for (const file of ['ShipIt_stdout.log', 'ShipIt_stderr.log']) {
        const log = join(path, file)
        if (existsSync(log)) writeFileSync(join(directory, file), readFileSync(log))
      }
    }
    clean()
  }
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ root, results }, null, 2))
} finally {
  clean()
}
