// 测试入口替换 main，生产源文件不替换权限、签名规则。只签专用探针，绝不改正式 Litch。
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LITCH_HOST_IDENTITY } from '../../host-identity.mjs'
import { fileHash, probeSigningPlan, reusableBuild, sourceFingerprint } from './build-contract.mjs'
import { PROBE_IDENTITY } from './identity.mjs'
import { acquireProbeBuildLock, probeAppPath } from './shared-probe.mjs'

const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, '../..')
// 可用已提交源码的导出副本做同夹具的前后对照，不切工作树或改正式助手。
const productRoot =
  process.env.LITCH_CU_PRODUCT_ROOT ??
  resolve(root, '../../third_party/litch-automation/apps/computer-use')
const out = probeAppPath()
const release = await acquireProbeBuildLock(out)
try {
  buildProbe()
} finally {
  await release()
}

function buildProbe() {
  const signing = probeSigningPlan(
    process.env.LITCH_CU_SIGN_IDENTITY,
    process.env.LITCH_SIGN_IDENTITY,
    process.env.LITCH_CU_SIGN_IDENTITY === undefined
      ? ''
      : execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
          encoding: 'utf8',
        }),
  )
  const coexist = process.argv.includes('--coexist')
  const fingerprint = sourceFingerprint(
    [
      { path: join(productRoot, 'Package.swift') },
      ...(existsSync(join(productRoot, 'Package.resolved'))
        ? [{ path: join(productRoot, 'Package.resolved') }]
        : []),
      { path: join(productRoot, 'Sources'), directory: true },
      ...[
        'build.mjs',
        'build-contract.mjs',
        'identity.mjs',
        'shared-probe.mjs',
        'ProbeLease.swift',
        '../../host-identity.mjs',
      ].map((name) => ({
        path: resolve(here, name),
      })),
      ...(coexist
        ? [
            '../coexist/main.swift',
            '../coexist/ElectronMatrix.swift',
            '../background/ProbeInput.swift',
          ]
        : ['main.swift']
      ).map((name) => ({ path: resolve(here, name) })),
    ],
    {
      out,
      signing,
      coexist,
      arch: process.arch,
      swift: execFileSync('swift', ['--version'], { encoding: 'utf8' }),
      sdk: execFileSync('xcrun', ['--show-sdk-version'], { encoding: 'utf8' }),
    },
  )
  const recordPath = `${out}.build.json`
  const verify = (appPath) =>
    execFileSync(
      'codesign',
      [
        '--verify',
        '--strict',
        ...(signing.requirement ? [`-R=${signing.requirement}`] : []),
        appPath,
      ],
      { stdio: 'inherit' },
    )
  if (!process.argv.includes('--rebuild') && reusableBuild(recordPath, fingerprint, out)) {
    verify(out)
    console.log(`复用未变更的测试探针（未构建、未签名）：${out}`)
    return
  }
  const staging = mkdtempSync(join(dirname(out), '.probe-build-'))
  const appPath = join(staging, `${PROBE_IDENTITY.helperName}.app`)
  try {
    execFileSync('swift', ['build', '--package-path', productRoot], { stdio: 'inherit' })
    const bin = execFileSync('swift', ['build', '--package-path', productRoot, '--show-bin-path'], {
      encoding: 'utf8',
    }).trim()
    const native = join(productRoot, 'Sources/LitchComputerUse')
    const core = join(bin, 'LitchComputerUseCore.build')
    mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true })
    writeFileSync(
      join(appPath, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${PROBE_IDENTITY.helperId}</string>
<key>CFBundleName</key><string>${PROBE_IDENTITY.helperName}</string>
<key>CFBundleDisplayName</key><string>${PROBE_IDENTITY.helperName}</string>
<key>CFBundleExecutable</key><string>${PROBE_IDENTITY.executableName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>ComputerUseHostIdentity</key><string>${JSON.stringify({
        ...LITCH_HOST_IDENTITY,
        helperId: PROBE_IDENTITY.helperId,
        helperName: PROBE_IDENTITY.helperName,
        directoryEnvironmentKey: PROBE_IDENTITY.directoryEnv,
        tokenEnvironmentKey: PROBE_IDENTITY.tokenEnv,
      })}</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`,
    )
    execFileSync(
      'swiftc',
      [
        '-swift-version',
        '5',
        '-I',
        join(bin, 'Modules'),
        ...readdirSync(native)
          .filter((n) => n.endsWith('.swift') && n !== 'main.swift')
          .map((n) => join(native, n)),
        join(here, 'ProbeLease.swift'),
        ...(coexist
          ? [
              join(here, '../coexist/main.swift'),
              join(here, '../coexist/ElectronMatrix.swift'),
              join(here, '../background/ProbeInput.swift'),
            ]
          : [join(here, 'main.swift')]),
        ...readdirSync(core)
          .filter((n) => n.endsWith('.swift.o'))
          .map((n) => join(core, n)),
        '-o',
        join(appPath, 'Contents/MacOS', PROBE_IDENTITY.executableName),
        '-framework',
        'AppKit',
        '-framework',
        'ScreenCaptureKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'Security',
      ],
      { stdio: 'inherit' },
    )
    execFileSync(
      'codesign',
      [
        '--force',
        '--sign',
        signing.identity,
        '--options',
        'runtime',
        signing.timestamp,
        ...(signing.requirement ? [`-r=designated => ${signing.requirement}`] : []),
        appPath,
      ],
      { stdio: 'inherit' },
    )
    verify(appPath)
    writeFileSync(
      join(staging, 'build.json'),
      JSON.stringify({
        fingerprint,
        executable: fileHash(join(appPath, 'Contents/MacOS', PROBE_IDENTITY.executableName)),
        plist: fileHash(join(appPath, 'Contents/Info.plist')),
      }),
    )
    const previous = join(staging, 'previous.app')
    if (existsSync(out)) renameSync(out, previous)
    try {
      renameSync(appPath, out)
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, out)
      throw error
    }
    renameSync(join(staging, 'build.json'), recordPath)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  console.log(out)
}
