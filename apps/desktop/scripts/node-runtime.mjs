// 取一份官方的 Node 可执行文件，装进应用里给内置的适配器用；适配器的独立发布包带的也是这一份
// （暂存的实现两边共用，在仓库根目录的 scripts/adapter-stage.mjs）。
//
// 适配器要用一份真的 Node 来跑，不能拿 Electron 冒充：引擎代码里有多处拿 process.execPath
// 去起 .js 形式的 harness 命令行（packages/shared/src/host-cli.mts 等），换成 Electron 的话
// 要么起出一个带界面的应用实例，要么得让 ELECTRON_RUN_AS_NODE 一路漏进用户的命令里。
//
// 做法：从 nodejs.org 下载固定版本的官方压缩包，对照写在这里的 SHA-256 校验，放进缓存目录
// （apps/desktop/.cache，不进版本库）。缓存里已经有的也每次重新校验，校验不过就当它不存在。
//
//   node scripts/node-runtime.mjs    只取不装：下载、校验，打印压缩包在哪
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** 和本机开发用的 Node 24 是同一个版本。换版本时下面的哈希要一起换 */
export const NODE_VERSION = '24.21.0'

/**
 * 官方压缩包（.tar.gz）的 SHA-256，取自 https://nodejs.org/dist/v24.21.0/SHASUMS256.txt。
 * 2026-10-13 取的时候核对过：那份清单带签名的版本（SHASUMS256.txt.asc）用 Node 发行密钥
 * （nodejs/release-keys 的钥匙环）验过，签名完好；darwin-arm64 的压缩包下载后实算一致。
 * 加别的平台或换版本时照同样的办法取，不要从别处抄。
 * linux 的两项是给独立发布包用的（scripts/package-adapter.mjs），同一天从同一份清单取的：
 * 清单的分离签名（SHASUMS256.txt.sig）用同一个钥匙环验过，签名完好；两个压缩包下载后实算一致。
 * 官方的 linux 包是按 glibc 编的，musl 的系统（Alpine）上跑不了。
 */
const SHA256 = {
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'linux-arm64': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  'linux-x64': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
}

/** 下载的压缩包缓存在哪 */
export const CACHE_DIR = fileURLToPath(new URL('../.cache/node', import.meta.url))

const sha256Of = async (file) => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** 压缩包里最外面那层目录的名字，也是压缩包去掉后缀的名字 */
const baseName = (platform, arch) => `node-v${NODE_VERSION}-${platform}-${arch}`

/**
 * 保证缓存里有一份校验过的压缩包，返回它的路径。
 * 哈希对不上（下载坏了、被换了）就删掉并报错，绝不把没校验过的东西交出去。
 */
export async function fetchNodeArchive({ platform = process.platform, arch = process.arch } = {}) {
  const expected = SHA256[`${platform}-${arch}`]
  if (!expected) {
    throw new Error(
      `还没有登记 ${platform}-${arch} 的 Node 压缩包哈希（见 scripts/node-runtime.mjs 里的 SHA256）`,
    )
  }
  const name = `${baseName(platform, arch)}.tar.gz`
  const archive = join(CACHE_DIR, name)
  if (existsSync(archive)) {
    if ((await sha256Of(archive)) === expected) return archive
    console.error(`缓存里的 ${name} 校验不过，重新下载`)
    rmSync(archive, { force: true })
  }

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`
  console.error(`下载 ${url}`)
  mkdirSync(CACHE_DIR, { recursive: true })
  // 先写到旁边的临时文件，校验过了才改成正式的名字：中途断掉不会留下一份看着完整的坏文件
  const partial = `${archive}.partial-${process.pid}`
  try {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    const actual = await sha256Of(partial)
    if (actual !== expected) {
      throw new Error(`${name} 的 SHA-256 对不上：应为 ${expected}，实际 ${actual}`)
    }
    renameSync(partial, archive)
  } finally {
    rmSync(partial, { force: true })
  }
  return archive
}

/**
 * 把 Node 装到 dest 下面：dest/bin/node 和 dest/LICENSE（分发它的可执行文件要带上许可）。
 * 压缩包里别的东西（npm、头文件、文档）都不要。dest 应当是一个新建的空目录。
 */
export async function installNode(dest, target = {}) {
  const { platform = process.platform, arch = process.arch } = target
  const archive = await fetchNodeArchive({ platform, arch })
  const top = baseName(platform, arch)
  mkdirSync(dest, { recursive: true })
  execFileSync(
    'tar',
    ['-xzf', archive, '-C', dest, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  return { node: join(dest, 'bin', 'node'), license: join(dest, 'LICENSE'), version: NODE_VERSION }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const archive = await fetchNodeArchive()
  console.log(`Node ${NODE_VERSION} 的压缩包已校验：${archive}`)
}
