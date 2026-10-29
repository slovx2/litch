// 把外壳和界面装成一个能直接打开的应用，放在 out/ 下面。
//
// 运行前外壳和界面都要先构建好（npm run client:pack 会按顺序做）。
// 外壳的三个入口已经各自打成了单个文件，依赖都在里面，所以装进应用的只有这几样：
//   package.json   只留名字、版本和入口
//   dist/          主进程、承载核心的工具进程、预加载脚本
//   ui/            界面的构建产物，主进程打包后从这里取（见 main.mts 里的 uiRoot）
//   assets/        只在 Linux 上带：窗口的图标（见 main.mts 里的 assetsDir）
// 不带 node_modules，也不带源码和自检脚本。
//
// 另外带一份适配器，本机这台设备靠它（见 src/local-adapter.mts）：先暂存成一个目录
// （stage-adapter.mjs，要求仓库根目录已经 npm run build 过），再作为额外的资源原样放进应用，
// 落在 Contents/Resources/adapter，不进 asar：里面的可执行文件得是磁盘上真的文件。
//
// macOS 上再带 Computer Use 的原生助手（apps/computer-use，Swift 构建）：落在 Contents/SharedSupport/Litch Computer Use.app。
// 放在 SharedSupport 而不是 Resources：它是一个完整的、单独签名的应用（系统授权记在它的包标识和签名上），
// SharedSupport 是苹果约定的放辅助应用的位置之一，codesign 认得出它是嵌套的代码；不放 Contents/Helpers 或
// Library/LoginItems，是因为它既不是 Electron 的辅助进程，也不是登录项。
//
// Windows 上带 Computer Use 的助手（apps/computer-use-win，Rust，见 win-helper.mjs）：作为额外的资源放进应用，
// 落在 resources/computer-use/litch-computer-use.exe，不进 asar（主进程直接 spawn 它）。
// 这里不构建它，要先编好；没有又没设 LITCH_WITHOUT_COMPUTER_USE=1 就报错。
//
// 再带一份许可文本：界面和外壳里打进去的第三方代码各自的许可（licenses.mjs），连同本项目自己的
// LICENSE 和 THIRD_PARTY_NOTICES.md，落在 Contents/Resources/licenses。
//
// 图标在 assets/ 下（icon.icns、icon.ico、icon.png，由 scripts/make-brand.py 从原图生成后提交进仓库），
// 应用自己的图标打包器按平台挑后缀；Linux 上窗口的图标是另外带进去的那张 icon.png。
//
// 这里出来的应用在 macOS 上只有本机的临时签名，换一台机器打开会被系统拦下。要发给别人的安装包
// （签名、公证过的 dmg，Windows 的安装程序）在这之后用 scripts/make-installer.mjs 做。
// Windows 上也能打包（发布流程里在 Windows 的机器上打）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'
import { buildHelper } from '../../computer-use/build-app.mjs'
import { NATIVE_DIRECTORY } from '../src/browser-import/protected/native/build.mjs'
import { collectLicenses } from './licenses.mjs'
import { NODE_VERSION } from './node-runtime.mjs'
import { OUT_DIR } from './packed.mjs'
import { signAdHoc } from './sign.mjs'
import { stageAdapter } from './stage-adapter.mjs'
import { requireWinHelper, WIN_HELPER_DIR, WIN_HELPER_EXE } from './win-helper.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const appDir = here('..')
const uiDist = here('../../../packages/ui/dist')
const stage = join(OUT_DIR, 'stage')

const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))

// Windows 的 Computer Use 助手先看在不在，免得前面忙了半天到最后才报
let winHelper = null
if (process.platform === 'win32') {
  try {
    winHelper = requireWinHelper()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  if (!winHelper)
    console.warn('已设 LITCH_WITHOUT_COMPUTER_USE=1：这次打出来的应用里没有 Computer Use 的助手')
}

const shell = ['main.mjs', 'core-host.mjs', 'preload.cjs', 'autofill-preload.cjs']
for (const file of shell) {
  if (!existsSync(join(appDir, 'dist', file))) {
    console.error(`没有找到外壳的构建产物 dist/${file}，请先运行 npm run build`)
    process.exit(1)
  }
}
if (!existsSync(join(uiDist, 'index.html'))) {
  console.error('没有找到界面的构建产物，请先运行 npm run build --prefix packages/ui')
  process.exit(1)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'dist'), { recursive: true })
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'litch',
      productName: manifest.productName,
      version: manifest.version,
      license: manifest.license,
      type: 'module',
      main: manifest.main,
    },
    null,
    2,
  )}\n`,
)
for (const file of shell) cpSync(join(appDir, 'dist', file), join(stage, 'dist', file))
cpSync(join(appDir, 'dist/chrome-extension'), join(stage, 'dist/chrome-extension'), {
  recursive: true,
})
if (process.platform === 'linux') {
  mkdirSync(join(stage, 'assets'), { recursive: true })
  cpSync(join(appDir, 'assets', 'icon.png'), join(stage, 'assets', 'icon.png'))
}
// 源码映射只在开发时有用，不带进应用
cpSync(uiDist, join(stage, 'ui'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
})

// 内置的适配器。暂存出来的目录留在 out/adapter，开发时可以用 LITCH_ADAPTER_ROOT 指过去
const adapter = await stageAdapter()
console.log(
  `内置的适配器：${adapter.packages.join('、')}，Node ${NODE_VERSION}，` +
    `${Math.round(adapter.total / 1024 / 1024)} MB`,
)

// 许可文本。目录名就是它在应用资源目录里的名字
const licenses = join(OUT_DIR, 'licenses')
const bundled = collectLicenses(licenses)
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(here(`../../../${file}`), join(licenses, file))
}
console.log(`许可文本：${bundled.length} 个第三方包`)

// Windows 的助手。目录名就是它在应用资源目录里的名字
const extraResource = [adapter.out, licenses]
if (process.platform === 'darwin') {
  const native = join(appDir, 'dist', NATIVE_DIRECTORY)
  for (const file of ['keychain.node', 'keychain-helper.mjs']) {
    if (!existsSync(join(native, file))) throw new Error(`缺少钥匙串桥 ${file}，请先构建桌面端。`)
  }
  extraResource.push(native)
}
const winHelperStage = join(OUT_DIR, WIN_HELPER_DIR)
if (winHelper) {
  rmSync(winHelperStage, { recursive: true, force: true })
  mkdirSync(winHelperStage, { recursive: true })
  cpSync(winHelper, join(winHelperStage, WIN_HELPER_EXE))
  extraResource.push(winHelperStage)
  console.log(`Computer Use 助手：${winHelper}`)
}

// 打包器要知道用哪一版 Electron：就用装着的这一版，它的压缩包安装时已经下到本机缓存里了
const require = createRequire(import.meta.url)
const electronVersion = require('electron/package.json').version

const [outPath] = await packager({
  dir: stage,
  out: OUT_DIR,
  name: manifest.productName,
  appBundleId: 'io.github.slovx2.litch',
  appVersion: manifest.version,
  appCategoryType: 'public.app-category.developer-tools',
  // Windows 上 Litch.exe 的文件属性里写的名字
  win32metadata: { CompanyName: 'slovx2', ProductName: 'Litch', FileDescription: 'Litch' },
  // 不带后缀：macOS 用 icon.icns，Windows 用 icon.ico
  icon: join(appDir, 'assets', 'icon'),
  platform: process.platform,
  arch: process.arch,
  electronVersion,
  asar: true,
  // 按目录名放进应用的资源目录，所以暂存目录必须叫 adapter（助手的叫 computer-use）
  extraResource,
  // 暂存目录里没有 node_modules，没有什么可剪的
  prune: false,
  overwrite: true,
  quiet: true,
})
rmSync(stage, { recursive: true, force: true })
rmSync(licenses, { recursive: true, force: true })
rmSync(winHelperStage, { recursive: true, force: true })

const appPath = join(outPath, `${manifest.productName}.app`)
if (process.platform === 'darwin') {
  const helper = buildHelper({ out: join(appPath, 'Contents', 'SharedSupport') })
  console.log(`Computer Use 助手：${helper}`)
}
// 临时签名只在本机有效。适配器带的可执行文件也要签到，见 sign.mjs
if (process.platform === 'darwin') signAdHoc(appPath)
console.log(`应用已装好：${process.platform === 'darwin' ? appPath : outPath}`)
