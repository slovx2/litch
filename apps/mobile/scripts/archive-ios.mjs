// 正式归档与导出共用一条路径；API key 只从外部文件读取，不输出其内容。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const mobile = join(root, 'apps/mobile')

export function releaseOptions(env) {
  assert.notEqual(env.LITCH_MOBILE_DEV, '1', '正式归档不能使用开发包')
  const team = env.LITCH_IOS_TEAM_ID ?? ''
  const build = env.LITCH_IOS_BUILD_NUMBER ?? ''
  assert.match(team, /^[A-Z0-9]{10}$/, '必须指定 LITCH_IOS_TEAM_ID')
  assert.match(build, /^[1-9]\d{0,3}(?:\.\d{1,2}){0,2}$/, '必须指定有效的 iOS 构建号')
  const auth = [env.LITCH_ASC_KEY_PATH, env.LITCH_ASC_KEY_ID, env.LITCH_ASC_ISSUER_ID]
  assert.ok(
    auth.every(Boolean) || auth.every((value) => !value),
    'API key 路径、ID、Issuer 必须同时提供',
  )
  if (auth[0]) {
    assert.ok(auth[0].startsWith('/'), 'API key 必须使用外部绝对路径')
    assert.ok(!resolve(auth[0]).startsWith(`${root}/`), 'API key 不能放在仓库内')
    assert.match(auth[1], /^[A-Z0-9]+$/)
    assert.match(auth[2], /^[a-f0-9-]{36}$/i)
  }
  return { team, build, auth }
}

export function exportPlist(team) {
  assert.match(team, /^[A-Z0-9]{10}$/)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>export</string>
<key>teamID</key><string>${team}</string>
<key>signingStyle</key><string>automatic</string>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>uploadSymbols</key><true/>
</dict></plist>\n`
}

function run(command, args, cwd = mobile, options = {}) {
  return execFileSync(command, args, { cwd, stdio: 'inherit', ...options })
}

function plist(path) {
  return JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], mobile, {
      stdio: 'pipe',
      encoding: 'utf8',
    }),
  )
}

export function verifyApp(info, entitlements, profile, expected) {
  assert.equal(info.CFBundleIdentifier, 'dev.litch.app')
  assert.equal(info.CFBundleShortVersionString, expected.version)
  assert.equal(info.CFBundleVersion, expected.build)
  assert.equal(entitlements['com.apple.developer.team-identifier'], expected.team)
  assert.equal(entitlements['get-task-allow'], false)
  assert.equal(profile.Entitlements['get-task-allow'], false)
  assert.ok(!profile.ProvisionedDevices, '不能使用 ad-hoc 或开发描述文件')
  assert.ok(!profile.ProvisionsAllDevices, '不能使用企业分发描述文件')
  assert.ok(profile.TeamIdentifier.includes(expected.team))
  assert.ok(Date.parse(profile.ExpirationDate) > Date.now(), '描述文件已过期')
  const appID = entitlements['application-identifier']
  assert.ok(appID.endsWith('.dev.litch.app'))
  assert.equal(profile.Entitlements['application-identifier'], appID)
  assert.ok(entitlements['keychain-access-groups'].includes(appID))
}

export function archive(env = process.env) {
  assert.equal(process.platform, 'darwin', 'iOS 归档需要 macOS/Xcode')
  const { team, build, auth } = releaseOptions(env)
  const output = resolve(env.LITCH_IOS_OUTPUT ?? join(mobile, '.release-ios'))
  mkdirSync(output, { recursive: true })
  const archivePath = join(output, 'Litch.xcarchive')
  const exportPath = join(output, 'export')
  const exportOptions = join(output, 'ExportOptions.plist')
  const authArgs = auth[0]
    ? [
        '-authenticationKeyPath',
        auth[0],
        '-authenticationKeyID',
        auth[1],
        '-authenticationKeyIssuerID',
        auth[2],
      ]
    : []
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version
  const manifest = join(mobile, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  run('npm', ['run', 'web:build'])
  run('bash', ['scripts/build-ssh-ios.sh'])
  try {
    run('npx', ['--no-install', 'expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install'])
    const generated = JSON.parse(readFileSync(manifest))
    for (const field of ['dependencies', 'devDependencies', 'overrides'])
      assert.deepEqual(generated[field], JSON.parse(before)[field], 'Expo 改变了锁定依赖')
  } finally {
    writeFileSync(manifest, before)
  }
  run('pod', ['_1.16.2_', 'install', '--project-directory=ios'])
  run('xcodebuild', [
    '-workspace',
    'ios/Litch.xcworkspace',
    '-scheme',
    'Litch',
    '-configuration',
    'Release',
    '-destination',
    'generic/platform=iOS',
    '-archivePath',
    archivePath,
    '-derivedDataPath',
    join(output, 'DerivedData'),
    '-allowProvisioningUpdates',
    ...authArgs,
    `DEVELOPMENT_TEAM=${team}`,
    'CODE_SIGN_STYLE=Automatic',
    'archive',
  ])
  writeFileSync(exportOptions, exportPlist(team))
  run('xcodebuild', [
    '-exportArchive',
    '-archivePath',
    archivePath,
    '-exportPath',
    exportPath,
    '-exportOptionsPlist',
    exportOptions,
    '-allowProvisioningUpdates',
    ...authArgs,
  ])
  const files = readdirSync(exportPath).filter((name) => name.endsWith('.ipa'))
  assert.equal(files.length, 1, '必须恰好导出一份 IPA')
  const ipa = join(exportPath, files[0])
  const unpack = join(output, 'verify')
  mkdirSync(unpack, { recursive: true })
  run('/usr/bin/ditto', ['-x', '-k', ipa, unpack])
  const apps = readdirSync(join(unpack, 'Payload')).filter((name) => name.endsWith('.app'))
  assert.equal(apps.length, 1)
  const app = join(unpack, 'Payload', apps[0])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const entitlementXML = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], mobile, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  const profileXML = run(
    '/usr/bin/security',
    ['cms', '-D', '-i', join(app, 'embedded.mobileprovision')],
    mobile,
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  )
  const parseXML = (xml) =>
    JSON.parse(
      run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], mobile, {
        input: xml,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      }),
    )
  // 描述文件含日期和证书 Data，不能整份转 JSON；只取用于校验的字段。
  const field = (key, format = 'json', optional = false) => {
    try {
      const value = run('/usr/bin/plutil', ['-extract', key, format, '-o', '-', '-'], mobile, {
        input: profileXML,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
      return format === 'json' ? JSON.parse(value) : value.trim()
    } catch (error) {
      if (optional && String(error.stderr).includes('No value at that key path')) return undefined
      throw error
    }
  }
  const profile = {
    Entitlements: field('Entitlements'),
    TeamIdentifier: field('TeamIdentifier'),
    ExpirationDate: field('ExpirationDate', 'raw'),
    ProvisionedDevices: field('ProvisionedDevices', 'json', true),
    ProvisionsAllDevices: field('ProvisionsAllDevices', 'json', true),
  }
  verifyApp(plist(join(app, 'Info.plist')), parseXML(entitlementXML), profile, {
    team,
    build,
    version,
  })
  // 原生资源包必须随静态桥一起进入最终 IPA。
  assert.ok(readdirSync(app).includes('LitchSshPrivacy.bundle'), 'IPA 缺少 SSH 隐私资源包')
  plist(join(app, 'LitchSshPrivacy.bundle/PrivacyInfo.xcprivacy'))
  const proof = {
    sha: run('git', ['rev-parse', 'HEAD'], root, { stdio: 'pipe', encoding: 'utf8' }).trim(),
    bundleId: 'dev.litch.app',
    version,
    build,
    team,
    sha256: createHash('sha256').update(readFileSync(ipa)).digest('hex'),
  }
  writeFileSync(join(output, 'ios-build.json'), `${JSON.stringify(proof, null, 2)}\n`)
  console.log(`IOS_ARCHIVE_VERIFIED ${JSON.stringify(proof)}`)
  return { ipa, proof }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) archive()
