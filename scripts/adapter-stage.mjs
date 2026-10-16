// 把适配器暂存成一棵自足的目录。两处用它，实现只有这一份：
//   桌面应用自带的那份   apps/desktop/scripts/stage-adapter.mjs，装进 Litch.app/Contents/Resources/adapter
//   独立发布包           scripts/package-adapter.mjs，放在压缩包的 libexec/ 下
//
// 目录里有什么（和 Homebrew 配方的 libexec 对齐）：
//   bin/codex-harness-adapter   Go 写的命令行，就地编译。终端用的伪终端桥也是它（pty-bridge 子命令）
//   node/bin/node               官方的 Node（apps/desktop/scripts/node-runtime.mjs），适配器的各个进程都用它跑
//   packages/<引擎>/            构建产物（不带测试），加只有运行依赖的 node_modules
//   node_modules/ package.json  根目录的运行依赖
//   protocol/                   协议的契约
// harness 本体（Claude Code 的命令行、Pi、dsh）一律不带，用的是用户自己装的那一份。
//
// 依赖的裁剪只在暂存目录里做：把仓库里装好的 node_modules 整个复制过来，再在副本上去掉开发依赖。
// 仓库自己的 node_modules 只读不写。
//
// 可以给别的系统和架构暂存（Go 交叉编译，Node 取对应的官方包）。这件事成立的前提是裁剪之后的依赖
// 全是纯 JavaScript：暂存完会查一遍（auditPlatform），混进了别的平台的二进制、或者留着分平台的包，
// 就不让过，改到目标平台上去构建。
import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installNode, NODE_VERSION } from '../apps/desktop/scripts/node-runtime.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

/**
 * 暂存目录最外面一层会有的名字。调用方靠它认“这是上一次暂存出来的，可以清空”。
 * scripts 现在不放了（原来里面是 python 写的伪终端桥）；名字留在这里，早先暂存出来的目录才清得掉。
 */
export const STAGED_ENTRIES = [
  'bin',
  'node',
  'packages',
  'node_modules',
  'protocol',
  'scripts',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

/**
 * 要带的包。entry 是它的入口，用来判断构建过没有。
 * device 是设备进程，聚合面就是它：少了它服务起得来，但本机这台设备连不上，所以和引擎一样是必需的。
 * 它没有自己的 node_modules，依赖从根目录解析。
 * Claude SDK 的可选平台包里自带一份 Claude Code 的命令行，所以它连可选依赖一起去掉。
 */
const PACKAGES = [
  {
    name: 'claude',
    entry: 'dist/claude/src/adapter.mjs',
    required: true,
    omit: ['dev', 'optional'],
  },
  { name: 'pi', entry: 'dist/pi/src/adapter.mjs', required: true, omit: ['dev'] },
  { name: 'dsh', entry: 'dist/dsh/src/adapter.mjs', required: true, omit: ['dev'] },
  { name: 'device', entry: 'dist/device/src/main.mjs', required: true, omit: ['dev'] },
]

/** harness 本体在 node_modules 里会是什么样子。出现任何一个就算暂存失败 */
const HARNESS = [
  { scope: '@anthropic-ai', match: (name) => name === 'claude-code', what: 'Claude Code 的命令行' },
  {
    scope: '@anthropic-ai',
    // 平台包的名字是 claude-agent-sdk-<系统>-<架构>，里面是命令行的可执行文件
    match: (name) => name.startsWith('claude-agent-sdk-'),
    what: 'Claude SDK 自带的命令行',
  },
  { scope: '@earendil-works', match: () => true, what: 'Pi 本体' },
  { scope: '@deepseek-ai', match: () => true, what: 'dsh 本体' },
]

const GO_ARCH = { arm64: 'arm64', x64: 'amd64' }

/** 复制一棵目录。符号链接照原样复制（不改成绝对路径）；同一个卷上用写时复制，不真的占两份地方 */
const copyTree = (from, to, filter) =>
  cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    ...(filter ? { filter } : {}),
  })

/**
 * 复制一份装好的依赖目录，准备在副本上裁剪。来源本身是符号链接的不收：链接会被照原样复制过去，
 * 随后的裁剪就经它落到原处，把那边装好的开发依赖裁掉（用导出副本并行干活时，副本里的依赖目录就是这样的链接）
 */
function copyModules(from, to) {
  if (lstatSync(from).isSymbolicLink())
    throw new Error(
      `${from} 是符号链接，不能从它暂存：裁剪依赖会经链接落到原处。请在依赖装在本目录里的仓库中运行`,
    )
  copyTree(from, to)
}

/** 目录里的每一项（不跟符号链接走）。visit 返回 false 就不往这个目录里面走 */
export function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (visit(path, entry) === false) continue
    if (entry.isDirectory()) walk(path, visit)
  }
}

export function sizeOf(path) {
  const info = lstatSync(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  walk(path, (child, entry) => {
    if (!entry.isDirectory()) total += lstatSync(child).size
  })
  return total
}

export const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** 在暂存目录里的一个包上去掉用不着的依赖。只许对暂存目录里的路径做 */
function prune(directory, out, omit) {
  const inside = relative(out, directory)
  if (inside.startsWith('..') || resolve(directory).startsWith(resolve(repo, 'packages') + sep)) {
    throw new Error(`拒绝在暂存目录之外裁剪依赖：${directory}`)
  }
  execFileSync(
    'npm',
    [
      'prune',
      ...omit.map((kind) => `--omit=${kind}`),
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    { cwd: directory, stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

/**
 * 依赖装好之后的收尾：去掉 .bin（里面全是符号链接，运行时用不着），去掉裁剪留下的空作用域目录，
 * 再确认没有 harness 本体、没有剩下的符号链接（装进应用后签名时会出问题，指向也可能落空）。
 */
function tidyModules(out) {
  const links = []
  walk(out, (path, entry) => {
    if (entry.isSymbolicLink()) {
      links.push(relative(out, path))
      return false
    }
    if (!entry.isDirectory()) return true
    if (entry.name === '.bin' && basename(join(path, '..')) === 'node_modules') {
      rmSync(path, { recursive: true, force: true })
      return false
    }
    if (entry.name.startsWith('@') && basename(join(path, '..')) === 'node_modules') {
      const inside = readdirSync(path)
      if (inside.length === 0) {
        rmSync(path, { recursive: true, force: true })
        return false
      }
      for (const rule of HARNESS) {
        if (rule.scope !== entry.name) continue
        const found = inside.filter(rule.match)
        if (found.length > 0) {
          throw new Error(
            `${rule.what}不应随适配器分发：${relative(out, path)}/${found.join('、')}`,
          )
        }
      }
    }
    return true
  })
  if (links.length > 0) {
    throw new Error(`暂存目录里还有符号链接：\n  ${links.slice(0, 20).join('\n  ')}`)
  }
}

/**
 * 构建产物是不是比源码旧。产物目录下面一层是包名（自己的，和编进来的 shared、protocol），各自对应
 * packages/<包名>/src；构建每次都把产物整个重写一遍，所以拿入口文件的时间当“上次构建的时间”，
 * 源码里有比它新的就是旧了。返回头一个比它新的源文件（相对仓库的写法），没有就是 null。
 * 不拦的话，改了源码（或者拉了新提交）忘了构建就去打包，装出来的是旧的适配器，而且看不出来
 */
export function staleSource(from, entry) {
  const built = lstatSync(join(from, entry)).mtimeMs
  const packages = dirname(from)
  for (const name of readdirSync(join(from, 'dist'))) {
    const source = join(packages, name, 'src')
    if (!existsSync(source)) continue
    let newer = null
    walk(source, (path, entry) => {
      if (newer === null && entry.isFile() && lstatSync(path).mtimeMs > built) newer = path
    })
    if (newer) return relative(dirname(packages), newer)
  }
  return null
}

/** 把一个包放进暂存目录：构建产物（不带测试）、依赖清单、只有运行依赖的 node_modules */
function stagePackage(spec, out, from = join(repo, 'packages', spec.name)) {
  if (!existsSync(join(from, spec.entry))) {
    if (spec.required) {
      throw new Error(
        `没有找到 packages/${spec.name} 的构建产物，请先在仓库根目录运行 npm run build`,
      )
    }
    // 少了设备进程，服务照样起得来，只是没有聚合面：装出来的应用本机这台设备连不上
    console.error(
      `提示：packages/${spec.name} 还没有构建产物，这次不带它。少了它，本机设备连不上（没有聚合面）`,
    )
    return false
  }
  const stale = staleSource(from, spec.entry)
  if (stale) {
    throw new Error(
      `packages/${spec.name} 的构建产物比源码旧（${stale} 在上次构建之后改过），请先在仓库根目录运行 npm run build`,
    )
  }
  const to = join(out, 'packages', spec.name)
  mkdirSync(to, { recursive: true })
  const dist = join(from, 'dist')
  // 产物目录下面一层是包名（自己的和共用的 shared），再下面的 test 是测试，不带
  copyTree(dist, join(to, 'dist'), (source) => relative(dist, source).split(sep)[1] !== 'test')
  // .npmrc 里有裁剪依赖时要用的设置（Pi 的插件把 Pi 本体声明成了对等依赖）
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
    if (existsSync(join(from, file))) cpSync(join(from, file), join(to, file))
  }
  if (existsSync(join(from, 'node_modules'))) {
    copyModules(join(from, 'node_modules'), join(to, 'node_modules'))
    prune(to, out, spec.omit)
  }
  rmSync(join(to, '.npmrc'), { force: true })
  return true
}

/**
 * 按文件头认原生二进制，返回它是给哪个系统、哪种架构的；不是就返回 null。
 * 只认这次会碰到的几种：ELF（Linux）、64 位的 Mach-O 和它的多架构包（macOS）、PE（Windows）。
 */
function nativeTarget(path) {
  const head = Buffer.alloc(64)
  const file = openSync(path, 'r')
  try {
    const length = readSync(file, head, 0, head.length, 0)
    if (length < 20) return null
    const magic = head.readUInt32BE(0)
    if (magic === 0x7f454c46) {
      // 架构在第 18 字节，字节序看第 5 字节（1 是小端）
      const machine = head[5] === 1 ? head.readUInt16LE(18) : head.readUInt16BE(18)
      const arch = { 62: 'x64', 183: 'arm64' }[machine] ?? `machine-${machine}`
      return { platform: 'linux', arch }
    }
    if (magic === 0xcffaedfe) {
      const cpu = head.readUInt32LE(4)
      const arch = { 16777228: 'arm64', 16777223: 'x64' }[cpu] ?? `cpu-${cpu}`
      return { platform: 'darwin', arch }
    }
    // Java 的 .class 开头也是这四个字节
    if (magic === 0xcafebabe && !path.endsWith('.class')) {
      return { platform: 'darwin', arch: 'universal' }
    }
    if (head.readUInt16BE(0) === 0x4d5a && length === head.length) {
      // “MZ”开头的不一定是 PE：再看它指过去的位置上有没有 PE 的签名
      const signature = Buffer.alloc(4)
      readSync(file, signature, 0, 4, head.readUInt32LE(60))
      if (signature.toString('latin1') === 'PE\0\0') return { platform: 'win32', arch: 'pe' }
    }
    return null
  } finally {
    closeSync(file)
  }
}

/** 依赖清单里 os、cpu、libc 的写法：列出来的才行，带感叹号的是排除 */
function allows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true
  if (list.includes(`!${value}`)) return false
  const named = list.filter((item) => !item.startsWith('!'))
  return named.length === 0 || named.includes(value)
}

/**
 * 暂存出来的东西是不是都能在目标平台上用。查三样：
 *   两个可执行文件（命令行、Node）是目标系统和架构的；
 *   别处没有原生二进制是给别的平台的（.node 插件、随包带的可执行文件）；
 *   留下来的依赖没有哪个声明了“不给这个系统、这种架构用”（官方 Node 是 glibc 的，所以 Linux 上还要求不排除 glibc）。
 * 依赖是从这台机器装好的 node_modules 复制来的。有一条不过，就说明它带着分平台的东西，
 * 这份暂存不能交出去：到目标平台上装依赖、构建，再在那里暂存。
 */
export function auditPlatform(out, platform, arch) {
  const executables = new Set(['bin/codex-harness-adapter', 'node/bin/node'])
  const problems = []
  walk(out, (path, entry) => {
    if (!entry.isFile()) return true
    const name = relative(out, path).split(sep).join('/')
    if (entry.name === 'package.json' && name.includes('node_modules/')) {
      let manifest
      try {
        manifest = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        // 有的包在测试材料里故意放着坏的 package.json
        return true
      }
      const fits =
        allows(manifest.os, platform) &&
        allows(manifest.cpu, arch) &&
        (platform !== 'linux' || allows(manifest.libc, 'glibc'))
      if (!fits) {
        const declared = ['os', 'cpu', 'libc']
          .filter((key) => manifest[key])
          .map((key) => `${key}=${JSON.stringify(manifest[key])}`)
        problems.push(`${name}：这个依赖声明了 ${declared.join(' ')}`)
      }
      return true
    }
    const native = nativeTarget(path)
    if (!native) return true
    if (native.platform === platform && native.arch === arch) executables.delete(name)
    else problems.push(`${name}：是 ${native.platform}-${native.arch} 的二进制`)
    return true
  })
  for (const name of executables) {
    if (!problems.some((problem) => problem.startsWith(`${name}：`))) {
      problems.push(`${name}：不是 ${platform}-${arch} 的可执行文件`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `暂存出来的东西不全是给 ${platform}-${arch} 用的，请改在目标平台上装依赖、构建并暂存：\n  ${problems
        .slice(0, 20)
        .join('\n  ')}`,
    )
  }
}

/**
 * 把适配器暂存到 out（必须不存在或是空目录；清不清旧的、半成品留不留由调用方管），返回它在哪、各部分多大。
 * 默认给本机的系统和架构；给别的时 Go 交叉编译，Node 取对应的官方包（不在本机试运行）。
 *   goFrom       命令行从哪份源码编译（里面要有 go.mod 和 cmd/codex-harness-adapter），默认是这个仓库
 *   deviceFrom   设备进程的包从哪儿取（里面要有 package.json 和构建好的 dist），默认是 packages/device
 *   staticGo     编译命令行时关掉 cgo：出来的是不依赖系统 C 库的可执行文件，而且在哪种机器上编都一样。
 *                独立发布包用它；桌面应用自带的那份照 Go 的默认值编，不带这一项
 */
export async function stageAdapterTree(
  out,
  {
    platform = process.platform,
    arch = process.arch,
    goFrom = repo,
    deviceFrom = join(repo, 'packages', 'device'),
    staticGo = false,
  } = {},
) {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`暂存的位置不是空的：${out}`)
  }
  mkdirSync(join(out, 'bin'), { recursive: true })

  // Go 的命令行：直接编译进暂存目录，不动仓库里的 bin/
  const goArch = GO_ARCH[arch]
  if (!goArch) throw new Error(`不认识的架构：${arch}`)
  const binary = join(out, 'bin', 'codex-harness-adapter')
  try {
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/codex-harness-adapter'], {
      cwd: resolve(goFrom),
      env: {
        ...process.env,
        GOOS: platform,
        GOARCH: goArch,
        ...(staticGo ? { CGO_ENABLED: '0' } : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  } catch (error) {
    throw new Error(
      error.code === 'ENOENT'
        ? '这台电脑上找不到 go 命令，编译不了适配器的命令行'
        : '适配器的命令行（cmd/codex-harness-adapter）没有编译通过，报错在上面',
    )
  }

  const { node } = await installNode(join(out, 'node'), { platform, arch })

  const staged = PACKAGES.filter((spec) =>
    stagePackage(spec, out, spec.name === 'device' ? resolve(deviceFrom) : undefined),
  ).map((spec) => spec.name)

  // 根目录的运行依赖
  for (const file of ['package.json', 'package-lock.json']) {
    cpSync(join(repo, file), join(out, file))
  }
  copyModules(join(repo, 'node_modules'), join(out, 'node_modules'))
  prune(out, out, ['dev'])

  copyTree(join(repo, 'protocol'), join(out, 'protocol'))
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(join(repo, file), join(out, file))
  }

  tidyModules(out)

  // 和 Homebrew 配方里的两条断言是同一个意思，这里再按路径直说一遍
  for (const [path, what] of [
    ['packages/pi/node_modules/@earendil-works', 'Pi 本体'],
    ['packages/dsh/node_modules/@deepseek-ai', 'dsh 本体'],
  ]) {
    if (existsSync(join(out, path))) throw new Error(`${what}不应随适配器分发：${path}`)
  }

  auditPlatform(out, platform, arch)

  // 给的是本机的系统和架构时试运行一下：Node 报得出预期的版本；
  // 命令行起得来，而且报得出版本号（它是从暂存目录里的 package.json 读的，这个文件不能少）
  if (platform === process.platform && arch === process.arch) {
    const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()
    if (version !== `v${NODE_VERSION}`) {
      throw new Error(`内置的 Node 报的版本是 ${version}，应为 v${NODE_VERSION}`)
    }
    const expected = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).version
    const reported = execFileSync(binary, ['version'], { encoding: 'utf8' }).trim()
    if (reported !== `codex-harness-adapter ${expected}`) {
      throw new Error(`命令行报的版本是“${reported}”，应为 codex-harness-adapter ${expected}`)
    }
    // 终端用的伪终端桥是这份命令行的子命令，引擎不再带别的桥：起一个命令，它的第一行得报“起来了”。
    // 只看第一行，不看退出码：这样起它，标准输入一上来就到头，桥按规矩当场把命令结束掉。
    if (process.platform !== 'win32') {
      const bridge = spawnSync(binary, ['pty-bridge', '--', '/bin/sh', '-c', 'exit 0'], {
        encoding: 'utf8',
      })
      const first = (bridge.stdout ?? '').split('\n')[0]
      if (!first.includes('"event":"spawned"')) {
        throw new Error(
          `命令行的 pty-bridge 子命令没有起来：${first || bridge.stderr || bridge.error?.message}`,
        )
      }
    }
  }

  const parts = {}
  for (const name of readdirSync(out)) {
    if (name === 'packages') {
      for (const child of readdirSync(join(out, name))) {
        parts[`packages/${child}`] = sizeOf(join(out, name, child))
      }
    } else {
      parts[name] = sizeOf(join(out, name))
    }
  }
  return { out, packages: staged, parts, total: sizeOf(out) }
}
