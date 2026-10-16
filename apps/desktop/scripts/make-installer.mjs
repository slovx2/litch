// 把装好的应用（npm run pack 出来的那一份）做成发给别人的安装包，放在 out/installer/ 下面。
//   macOS    Litch-<版本>-macos-<架构>.dmg
//   Windows  Litch-<版本>-windows-<架构>-setup.exe（Inno Setup 6.7.1 编，见 packaging/litch.iss；不签名）
//
// macOS 上给了开发者身份就签名并公证：
//   LITCH_SIGN_IDENTITY     “Developer ID Application”证书的名字或者它的 SHA-1
//   LITCH_SIGN_KEYCHAIN     证书在哪个钥匙串里（不给就在默认的那几个里找；同名的证书在几个钥匙串里都有时要给）
//   LITCH_NOTARY_PROFILE    公证凭据：notarytool 存在钥匙串里的配置名（xcrun notarytool store-credentials 存的）
//   LITCH_NOTARY_KEYCHAIN   这份配置不在默认的钥匙串里时，它在哪个钥匙串里
// 本机用登录钥匙串里的证书和已经存好的配置；发布流程把机密导进一个临时钥匙串，再存一份配置（见 release.yml）。
// 顺序：内置适配器里的两个可执行文件先各自签（加固的运行时，Node 带上它要的权限，见 packaging/node.entitlements.plist）；
// 再用 @electron/osx-sign 签 Electron 的部分和整个应用（它会把 Resources 下面所有像二进制的文件都签一遍，
// 适配器那一大棵依赖不该这样，所以让它跳过适配器目录）；然后公证应用、把公证票钉进去；
// 做成 dmg，给 dmg 签名、公证、钉票。
// 没给身份时只有 npm run pack 做的本机临时签名，dmg 不签不公证，换一台机器打开会被系统拦下；
// 带 --require-signing 时（发布流程）这样就报错。
//
//   node scripts/make-installer.mjs [--require-signing]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sign } from '@electron/osx-sign'
import { HELPER_APP_NAME, helperTeam, signHelper } from '../../computer-use/build-app.mjs'
import { OUT_DIR } from './packed.mjs'
import { machOFiles } from './sign.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const manifest = JSON.parse(readFileSync(here('../package.json'), 'utf8'))
const version = manifest.version
const installerDir = join(OUT_DIR, 'installer')
const requireSigning = process.argv.includes('--require-signing')

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 开发者身份和公证凭据。一个都没给就是 null；只给了一半是配错了，直接报 */
function credentials() {
  const identity = process.env.LITCH_SIGN_IDENTITY
  const profile = process.env.LITCH_NOTARY_PROFILE
  if (!identity && !profile) return null
  if (!identity || !profile) {
    throw new Error(
      `签名和公证的设置不全，缺 ${identity ? 'LITCH_NOTARY_PROFILE' : 'LITCH_SIGN_IDENTITY'}`,
    )
  }
  const notaryKeychain = process.env.LITCH_NOTARY_KEYCHAIN
  return {
    identity,
    keychain: process.env.LITCH_SIGN_KEYCHAIN || undefined,
    notary: [
      '--keychain-profile',
      profile,
      ...(notaryKeychain ? ['--keychain', notaryKeychain] : []),
    ],
  }
}

/** 交给苹果公证，等结果。没过就把苹果给的日志打出来再报错 */
function notarize(file, creds) {
  console.log(`公证 ${basename(file)}（要等几分钟）`)
  const submit = spawnSync(
    'xcrun',
    ['notarytool', 'submit', file, ...creds.notary, '--wait', '--output-format', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  let result = null
  try {
    result = JSON.parse(submit.stdout)
  } catch {}
  if (result?.status === 'Accepted') return
  if (result?.id) {
    spawnSync('xcrun', ['notarytool', 'log', result.id, ...creds.notary], { stdio: 'inherit' })
  }
  throw new Error(
    `${basename(file)} 没有通过公证：${result ? `${result.status}，${result.message}` : submit.stdout}`,
  )
}

/** hdiutil 在 CI 的机器上偶尔报“资源忙”，再试两次 */
function createImage(source, dmg) {
  for (let attempt = 1; ; attempt += 1) {
    const made = spawnSync(
      'hdiutil',
      ['create', '-volname', 'Litch', '-srcfolder', source, '-format', 'UDZO', '-ov', dmg],
      { stdio: 'inherit' },
    )
    if (made.status === 0) return
    if (attempt === 3) throw new Error('hdiutil 没能做出 dmg，报错在上面')
    spawnSync('sleep', [String(attempt * 5)])
  }
}

async function macos() {
  const app = join(OUT_DIR, `Litch-darwin-${process.arch}`, 'Litch.app')
  if (!existsSync(app)) throw new Error(`没有找到装好的应用 ${app}，请先运行 npm run pack`)
  const creds = credentials()
  if (!creds && requireSigning) {
    throw new Error('发布用的安装包必须签名并公证，可签名和公证的设置一个都没给')
  }
  const keychain = creds?.keychain ? ['--keychain', creds.keychain] : []

  if (creds) {
    const adapter = join(app, 'Contents', 'Resources', 'adapter')
    for (const file of machOFiles(adapter)) {
      const entitlements =
        basename(file) === 'node'
          ? ['--entitlements', here('../packaging/node.entitlements.plist')]
          : []
      run('codesign', [
        '--force',
        '--sign',
        creds.identity,
        ...keychain,
        '--options',
        'runtime',
        '--timestamp',
        ...entitlements,
        file,
      ])
    }
    // Computer Use 的助手：自己的签名（加固的运行时、没有额外权限、固定的签名标识），osx-sign 跳过它，
    // 免得被套上 Electron 那一份权限
    const helper = join(app, 'Contents', 'SharedSupport', HELPER_APP_NAME)
    const helperTeamId = signHelper(helper, creds)
    await sign({
      app,
      identity: creds.identity,
      keychain: creds.keychain,
      platform: 'darwin',
      ignore: (file) => file.startsWith(adapter + sep) || file.startsWith(helper),
    })
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    // 助手和 Litch 必须是同一个团队签的：助手只认同团队签名的 Litch 连进来
    const appTeam = helperTeam(app)
    if (!helperTeamId || helperTeamId !== appTeam) {
      throw new Error(`Computer Use 助手的团队号（${helperTeamId}）和 Litch 的（${appTeam}）对不上`)
    }
    run(join(helper, 'Contents', 'MacOS', 'LitchComputerUse'), ['--diagnostics'])
    // 加固的运行时下内置的 Node 还跑得起来（少了即时编译的权限，V8 一起来就崩），命令行也是
    const node = join(adapter, 'node', 'bin', 'node')
    run(node, ['-e', 'console.log(`内置的 Node 能跑：${process.version}`)'])
    run(join(adapter, 'bin', 'codex-harness-adapter'), ['version'])

    const zip = join(OUT_DIR, 'Litch-notarize.zip')
    run('ditto', ['-c', '-k', '--keepParent', app, zip])
    notarize(zip, creds)
    rmSync(zip, { force: true })
    run('xcrun', ['stapler', 'staple', app])
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  } else {
    console.warn(
      '没有给开发者身份：应用只有本机的临时签名，dmg 不签名也不公证，换一台机器打开会被系统拦下',
    )
  }

  // dmg 里放应用和一个指向“应用程序”文件夹的链接，打开后拖过去就装好了
  const content = join(OUT_DIR, 'dmg')
  rmSync(content, { recursive: true, force: true })
  mkdirSync(content, { recursive: true })
  run('ditto', [app, join(content, 'Litch.app')])
  symlinkSync('/Applications', join(content, 'Applications'))
  const dmg = join(installerDir, `Litch-${version}-macos-${process.arch}.dmg`)
  createImage(content, dmg)
  rmSync(content, { recursive: true, force: true })

  if (creds) {
    run('codesign', ['--force', '--sign', creds.identity, ...keychain, '--timestamp', dmg])
    notarize(dmg, creds)
    run('xcrun', ['stapler', 'staple', dmg])
    run('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=2',
      dmg,
    ])
  }
  return dmg
}

function windows() {
  const source = join(OUT_DIR, `Litch-win32-${process.arch}`)
  if (!existsSync(join(source, 'Litch.exe'))) {
    throw new Error(`没有找到装好的应用 ${source}，请先运行 npm run pack`)
  }
  const iscc =
    process.env.LITCH_ISCC ||
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe')
  if (!existsSync(iscc)) {
    throw new Error(
      `找不到 Inno Setup 的编译器 ${iscc}（要 6.7.1；装在别处时用 LITCH_ISCC 指过去）`,
    )
  }
  const name = `Litch-${version}-windows-${process.arch}-setup`
  run(iscc, [
    `/DAppVersion=${version}`,
    `/DSourceDir=${source}`,
    `/DOutputDir=${installerDir}`,
    `/DOutputName=${name}`,
    `/DIconFile=${here('../assets/icon.ico')}`,
    here('../packaging/litch.iss'),
  ])
  return join(installerDir, `${name}.exe`)
}

try {
  rmSync(installerDir, { recursive: true, force: true })
  mkdirSync(installerDir, { recursive: true })
  let installer
  if (process.platform === 'darwin') installer = await macos()
  else if (process.platform === 'win32') installer = windows()
  else throw new Error(`这一版只出 macOS 和 Windows 的安装包，不出 ${process.platform} 的`)
  console.log(`安装包：${installer}\nSHA-256：${sha256Of(installer)}`)
} catch (error) {
  console.error(`安装包没有做成：${error.message}`)
  process.exit(1)
}
