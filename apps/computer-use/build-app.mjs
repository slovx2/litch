// 把 Swift 包构建出来的可执行文件组装成无界面的 “Litch Computer Use.app”，并签名。
//
// 应用的样子：
//   Contents/Info.plist              包标识 io.github.slovx2.litch.computer-use，LSUIElement（没有程序坞图标、没有菜单栏），
//                                    版本号跟仓库根目录 package.json 的走
//   Contents/MacOS/LitchComputerUse  可执行文件
//   Contents/Resources/icon.icns     借 Litch 的图标（用户在“隐私与安全性”里看到的就是它）
// 签名：开加固的运行时（公证要求），不要任何额外的权限（entitlements）。给了开发者身份就用它并带时间戳；
// 没给就是本机的临时签名（这时助手没有团队号，连进来的进程要凭拉起时给的一次性令牌，见 PeerAuth.swift）。
//
//   node apps/computer-use/build-app.mjs [--out 目录] [--identity 证书名或SHA-1] [--keychain 钥匙串] [--debug]
// 证书没从参数给时看环境变量 LITCH_SIGN_IDENTITY（和安装包用的同一个），钥匙串看 LITCH_SIGN_KEYCHAIN。
// 打包（apps/desktop/scripts/pack.mjs）和做安装包（make-installer.mjs）引用这里导出的函数。
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

/** 包的目录 */
export const PACKAGE_DIR = here('.')
/** 应用的名字（也是在系统设置里显示的名字） */
export const HELPER_APP_NAME = 'Litch Computer Use.app'
/** 包标识。改了它，用户之前给的授权就全没了 */
export const HELPER_BUNDLE_ID = 'io.github.slovx2.litch.computer-use'
const EXECUTABLE = 'LitchComputerUse'

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })

function infoPlist(version) {
  const entries = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: 'Litch Computer Use',
    CFBundleExecutable: EXECUTABLE,
    CFBundleIconFile: 'icon',
    CFBundleIdentifier: HELPER_BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'Litch Computer Use',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: '14.0',
    LSUIElement: true,
    NSHumanReadableCopyright: 'MIT',
    NSPrincipalClass: 'NSApplication',
  }
  const body = Object.entries(entries)
    .map(([key, value]) => {
      const node = value === true ? '<true/>' : `<string>${value}</string>`
      return `  <key>${key}</key>\n  ${node}`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`
}

/**
 * 构建并组装应用，返回应用的路径。不签名（签名见 signHelper）。
 * arch 是 Node 的写法（arm64、x64），默认本机的
 */
export function buildHelper({
  out = join(PACKAGE_DIR, 'out'),
  arch = process.arch,
  debug = false,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('Litch Computer Use 只在 macOS 上构建')
  const swiftArch = arch === 'x64' ? 'x86_64' : 'arm64'
  const args = ['build', '--package-path', PACKAGE_DIR, '-c', debug ? 'debug' : 'release']
  args.push('--arch', swiftArch)
  run('swift', args)
  const binDir = execFileSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' }).trim()
  const binary = join(binDir, EXECUTABLE)
  if (!existsSync(binary)) throw new Error(`没有找到构建出来的 ${binary}`)

  const version = JSON.parse(readFileSync(here('../../package.json'), 'utf8')).version
  const app = join(out, HELPER_APP_NAME)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), infoPlist(version))
  writeFileSync(join(app, 'Contents', 'PkgInfo'), 'APPL????')
  cpSync(binary, join(app, 'Contents', 'MacOS', EXECUTABLE))
  chmodSync(join(app, 'Contents', 'MacOS', EXECUTABLE), 0o755)
  cpSync(here('../desktop/assets/icon.icns'), join(app, 'Contents', 'Resources', 'icon.icns'))
  return app
}

/**
 * 给助手签名：加固的运行时，没有额外权限。identity 不给或是 '-' 时做临时签名。
 * 返回签上的团队号（临时签名是 null）
 */
export function signHelper(app, { identity, keychain } = {}) {
  const real = identity && identity !== '-'
  run('codesign', [
    '--force',
    '--sign',
    real ? identity : '-',
    ...(real && keychain ? ['--keychain', keychain] : []),
    '--options',
    'runtime',
    ...(real ? ['--timestamp'] : []),
    '--identifier',
    HELPER_BUNDLE_ID,
    app,
  ])
  run('codesign', ['--verify', '--strict', '--verbose=1', app])
  return helperTeam(app)
}

/** 读助手签名里的团队号（临时签名没有，回 null） */
export function helperTeam(app) {
  // codesign -d 的信息打在标准错误上
  const shown = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' })
  const team = /TeamIdentifier=(\S+)/.exec(`${shown.stdout}${shown.stderr}`)?.[1]
  return team && team !== 'not' ? team : null
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const app = buildHelper({
      out: option('--out') ?? join(PACKAGE_DIR, 'out'),
      debug: process.argv.includes('--debug'),
    })
    const team = signHelper(app, {
      identity: option('--identity') ?? process.env.LITCH_SIGN_IDENTITY,
      keychain: option('--keychain') ?? process.env.LITCH_SIGN_KEYCHAIN,
    })
    console.log(`助手已组装并签名：${app}（${team ? `团队号 ${team}` : '临时签名'}）`)
  } catch (error) {
    console.error(`助手没有做成：${error.message}`)
    process.exit(1)
  }
}
