// 只构建探针，不改产品助手，不安装依赖。所有产物写在显式给出的目录。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? join(source, '../../.artifacts/background'))
const identity = process.env.LITCH_SIGN_IDENTITY ?? '-'

function build(name, id, sources) {
  const app = join(out, `${name}.app`)
  const contents = join(app, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleDisplayName</key><string>${name}</string>
<key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`,
  )
  execFileSync(
    '/usr/bin/swiftc',
    [
      '-swift-version',
      '5',
      ...sources.map((s) => join(source, s)),
      '-o',
      join(contents, 'MacOS/Probe'),
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      identity,
      '--options',
      'runtime',
      ...(identity === '-' ? [] : ['--timestamp']),
      app,
    ],
    { stdio: 'inherit' },
  )
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'inherit' })
  console.log(app)
}

build('Litch Background Input Probe', 'io.github.slovx2.litch.background-input-probe', [
  'main.swift',
  'ProbeInput.swift',
  'ProbeDiagnostics.swift',
])
if (existsSync(join(source, 'Fixture.swift'))) {
  build('Litch Background Fixture', 'io.github.slovx2.litch.background-fixture', ['Fixture.swift'])
  build('Litch Background Guard', 'io.github.slovx2.litch.background-guard', ['Fixture.swift'])
}
