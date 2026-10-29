// 测试入口替换 main，生产源文件不替换权限、签名规则。只签专用探针，绝不改正式 Litch。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, '../..')
execFileSync('swift', ['build', '--package-path', root], { stdio: 'inherit' })
const bin = execFileSync('swift', ['build', '--package-path', root, '--show-bin-path'], {
  encoding: 'utf8',
}).trim()
const native = join(root, 'Sources/LitchComputerUse')
const core = join(bin, 'LitchComputerUseCore.build')
const out = join(root, '.artifacts/integration/Litch Background Input Probe.app')
mkdirSync(join(out, 'Contents/MacOS'), { recursive: true })
writeFileSync(
  join(out, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.slovx2.litch.background-input-probe</string>
<key>CFBundleName</key><string>Litch Background Input Probe</string>
<key>CFBundleDisplayName</key><string>Litch Background Input Probe</string>
<key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
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
    join(here, 'main.swift'),
    ...readdirSync(core)
      .filter((n) => n.endsWith('.swift.o'))
      .map((n) => join(core, n)),
    '-o',
    join(out, 'Contents/MacOS/Probe'),
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
const identity = process.env.LITCH_SIGN_IDENTITY
if (!identity) throw new Error('请显式提供探针 Developer ID 身份')
execFileSync(
  'codesign',
  ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', out],
  { stdio: 'inherit' },
)
execFileSync('codesign', ['--verify', '--strict', out], { stdio: 'inherit' })
writeFileSync(join(root, '.artifacts/integration/build-path.txt'), `${out}\n`)
console.log(out)
