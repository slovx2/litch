// 出适配器的独立发布包：解开就能用，机器上不用另装 Node 和 Go。给远程设备和不用 Homebrew 的人。
//
//   node scripts/package-adapter.mjs [--target 目标[,目标…]] [--out 目录]
//     --target   linux-x64、linux-arm64、darwin-arm64，逗号隔开可以给多个；host 是本机，all 是三个都出。默认 host
//     --out      产物放哪，默认 .artifacts/release
//     --go-from、--device-from   同 apps/desktop/scripts/stage-adapter.mjs：工作区里这两处正被改到一半时，
//                指到一份已提交版本的导出副本上（做法见 scripts/client-local-fixture.mjs 开头）
//   先在仓库根目录 npm run build。
//
// 产物：
//   codex-harness-adapter-<版本>-<系统>-<架构>.tar.gz
//   codex-harness-adapter-SHA256SUMS.txt   这次出的每个压缩包一行，sha256sum 认的格式
//   install.sh                              安装脚本的副本，发布时和压缩包一起挂到发布页
//
// 压缩包里（最外面一层目录和压缩包同名）：
//   bin/codex-harness-adapter   入口（scripts/adapter-launcher.sh）：找到真实的位置，把参数原样交给 libexec 里的命令行
//   bin/litch-machine           同一个入口脚本，按这个名字调用时是 machine 子命令（短名，08 号设计决 245）
//   libexec/                    暂存出来的适配器，和桌面应用自带的那份是同一份实现（scripts/adapter-stage.mjs）
//   install.sh                  安装脚本，装好之后升级、卸载还用得着
//   LICENSE、THIRD_PARTY_NOTICES.md
//
// 可以在一台机器上出别的系统和架构的包：命令行是 Go 交叉编译的，Node 取对应的官方包，
// 其余的依赖裁剪之后全是纯 JavaScript（暂存时会查，不是就不让过）。
// 压缩包是这里自己写的，不用系统的 tar：macOS 的 tar 会把扩展属性一起装进去，到 Linux 上解出一堆杂项；
// 自己写还能让条目的顺序、属主、时间都是定的。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { megabytes, stageAdapterTree } from './adapter-stage.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

/** 出哪些系统和架构的包 */
export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64']
/** 校验和清单的名字。不带版本号：安装脚本先取它，从里面的文件名知道最新是哪一版 */
export const CHECKSUMS = 'codex-harness-adapter-SHA256SUMS.txt'
export const packageName = (version, target) => `codex-harness-adapter-${version}-${target}`

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * 把一个目标的包摆出来（还没压缩），返回它在哪、是哪一版。
 * work 是放它的地方，最好和仓库在同一个卷上：复制依赖时用得上写时复制。
 */
export async function stageStandalone({ target, work, goFrom, deviceFrom }) {
  if (!TARGETS.includes(target)) {
    throw new Error(`不出 ${target} 的包。可以给的目标：${TARGETS.join('、')}`)
  }
  const [platform, arch] = target.split('-')
  const root = join(work, target)
  mkdirSync(join(root, 'bin'), { recursive: true })
  const staged = await stageAdapterTree(join(root, 'libexec'), {
    platform,
    arch,
    goFrom,
    deviceFrom,
    staticGo: true,
  })
  const launcher = join(root, 'bin', 'codex-harness-adapter')
  const short = join(root, 'bin', 'litch-machine')
  cpSync(join(repo, 'scripts', 'adapter-launcher.sh'), launcher)
  // 拷一份而不是链接：压缩包里不放链接，装的时候 ~/.local/bin 里的链接指向它
  cpSync(join(repo, 'scripts', 'adapter-launcher.sh'), short)
  cpSync(join(repo, 'scripts', 'install.sh'), join(root, 'install.sh'))
  for (const file of [launcher, short, join(root, 'install.sh')]) chmodSync(file, 0o755)
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(join(repo, file), join(root, file))
  }

  // 命令行报的版本取自根目录的清单，设备进程报给客户端的取自它自己的清单：两处要是同一个号
  const version = readJson(join(root, 'libexec', 'package.json')).version
  const device = readJson(join(root, 'libexec', 'packages', 'device', 'package.json')).version
  if (device !== version) {
    throw new Error(`根目录的版本号是 ${version}，packages/device 的是 ${device}，两处要一致`)
  }
  // 是本机的系统和架构就经入口试运行一下：入口找得到随包带的命令行
  if (platform === process.platform && arch === process.arch) {
    const reported = execFileSync(launcher, ['version'], { encoding: 'utf8' }).trim()
    if (reported !== `codex-harness-adapter ${version}`) {
      throw new Error(`入口报的版本是“${reported}”，应为 codex-harness-adapter ${version}`)
    }
    // 短名就是 machine 子命令。套接字指到不存在的地方：说明照样给，不去碰这台机器上在跑的设备服务
    const help = execFileSync(short, ['--help'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CHA_LANG: 'en',
        LITCH_DEVICE_SOCKET: join(root, 'no-such-device.sock'),
      },
    })
    if (!help.startsWith('litch-machine: ')) {
      throw new Error(`短名 litch-machine 的说明不对：${help.slice(0, 200)}`)
    }
  }
  return { root, target, version, staged }
}

/** 只给验证用：把摆好的包改成另一个版本号（装旧的再装新的，要两个号不一样的包） */
export function relabel(staged, version) {
  for (const path of ['libexec/package.json', 'libexec/packages/device/package.json']) {
    const file = join(staged.root, path)
    const manifest = readJson(file)
    manifest.version = version
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  staged.version = version
}

/** tar 里的一个 512 字节的头。名字超过 100 字节的由调用方先写一条长名字的记录 */
function tarHeader(name, { size, mode, type, mtime }) {
  const header = Buffer.alloc(512)
  Buffer.from(name).copy(header, 0, 0, 100)
  const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`
  header.write(octal(mode, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(mtime, 12), 136)
  header.write('        ', 148)
  header.write(type, 156)
  // GNU 格式的标记：长名字的记录是 GNU 的扩展，GNU tar、bsdtar、busybox 都认
  header.write('ustar  \0', 257)
  header.write('root', 265)
  header.write('root', 297)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

const padding = (size) => Buffer.alloc((512 - (size % 512)) % 512)

/** 一棵目录变成 tar 的字节流。里面只能有普通文件和目录（暂存时已经保证没有符号链接） */
async function* tarEntries(directory, prefix, mtime) {
  const entry = (name, fields) => {
    const bytes = Buffer.byteLength(name)
    if (bytes <= 100) return [tarHeader(name, fields)]
    const long = Buffer.from(`${name}\0`)
    return [
      tarHeader('././@LongLink', { size: long.length, mode: 0o644, type: 'L', mtime: 0 }),
      long,
      padding(long.length),
      tarHeader(name, fields),
    ]
  }
  yield* entry(`${prefix}/`, { size: 0, mode: 0o755, type: '5', mtime })
  const names = readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    const path = join(directory, name)
    const info = lstatSync(path)
    if (info.isDirectory()) {
      yield* tarEntries(path, `${prefix}/${name}`, mtime)
    } else if (info.isFile()) {
      // 权限只留“能不能执行”这一点，别的不跟着出包的那台机器走
      const mode = info.mode & 0o111 ? 0o755 : 0o644
      yield* entry(`${prefix}/${name}`, { size: info.size, mode, type: '0', mtime })
      yield* createReadStream(path)
      yield padding(info.size)
    } else {
      throw new Error(`包里只能有普通文件和目录：${path}`)
    }
  }
}

async function sha256Of(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** 把摆好的包压成 <名字>.tar.gz 放进 outDir，返回文件名、大小和 SHA-256。level 是压缩的力度，发布用最大的 */
export async function writeArchive(staged, outDir, level = 9) {
  const name = packageName(staged.version, staged.target)
  const file = join(outDir, `${name}.tar.gz`)
  mkdirSync(outDir, { recursive: true })
  // 条目的时间：给了 SOURCE_DATE_EPOCH 就用它，同一份源码出来的包才可能一样
  const mtime = Number(process.env.SOURCE_DATE_EPOCH) || Math.floor(Date.now() / 1000)
  async function* archive() {
    yield* tarEntries(staged.root, name, mtime)
    // 结尾是两个全零的块
    yield Buffer.alloc(1024)
  }
  await pipeline(Readable.from(archive()), createGzip({ level }), createWriteStream(file))
  return {
    file,
    name: `${name}.tar.gz`,
    bytes: lstatSync(file).size,
    sha256: await sha256Of(file),
  }
}

/** 校验和清单：每个压缩包一行，sha256sum -c 认的格式 */
export function writeChecksums(outDir, archives) {
  const lines = archives
    .map((archive) => `${archive.sha256}  ${archive.name}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
  const file = join(outDir, CHECKSUMS)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

/** 在 outDir 里开一个临时的地方摆包，run 结束（成不成都）删掉 */
export async function withWork(outDir, run) {
  mkdirSync(outDir, { recursive: true })
  const work = mkdtempSync(join(outDir, '.stage-'))
  try {
    return await run(work)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) => {
    const at = process.argv.indexOf(name)
    return at > 0 ? process.argv[at + 1] : undefined
  }
  const host = `${process.platform}-${process.arch}`
  const wanted = (option('--target') ?? 'host')
    .split(',')
    .flatMap((target) => (target === 'all' ? TARGETS : [target === 'host' ? host : target]))
  const outDir = resolve(option('--out') ?? join(repo, '.artifacts', 'release'))
  try {
    const archives = await withWork(outDir, async (work) => {
      const done = []
      for (const target of [...new Set(wanted)]) {
        const staged = await stageStandalone({
          target,
          work,
          goFrom: option('--go-from'),
          deviceFrom: option('--device-from'),
        })
        const archive = await writeArchive(staged, outDir)
        console.log(
          `${archive.name}  ${megabytes(archive.bytes)}（解开 ${megabytes(staged.staged.total)}）`,
        )
        console.log(`  sha256 ${archive.sha256}`)
        done.push(archive)
        rmSync(staged.root, { recursive: true, force: true })
      }
      return done
    })
    writeChecksums(outDir, archives)
    cpSync(join(repo, 'scripts', 'install.sh'), join(outDir, 'install.sh'))
    console.log(`发布包已出：${outDir}（${archives.length} 个压缩包、${CHECKSUMS}、install.sh）`)
  } catch (error) {
    console.error(`发布包没有出成：${error.message}`)
    process.exit(1)
  }
}
