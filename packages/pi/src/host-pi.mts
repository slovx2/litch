import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveHostCli } from '../../shared/src/host-cli.mjs'

export const PI_PACKAGE = '@earendil-works/pi-coding-agent'

export interface HostPi {
  cli: string
  root: string
  version: string
  sdkEntry: string
  aiEntry: string
}

function manifest(directory: string): any {
  const path = join(directory, 'package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

// 按清单取 ESM 主入口，升级后入口文件改名也能跟上。
function importEntry(root: string): string {
  const pkg = manifest(root)
  const entry = pkg.exports?.['.']?.import ?? pkg.main
  if (typeof entry !== 'string') throw new Error(`用户安装的 ${pkg.name} 缺少 ESM 入口`)
  return join(root, entry)
}

// 与 Node 相同的逐级 node_modules 查找，兼容 npm 的嵌套、提升和 pnpm 的布局。
function dependencyRoot(from: string, name: string): string {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (directory === dirname(directory))
      throw new Error(`用户安装的 Pi 缺少依赖 ${name}，请重新安装 Pi`)
  }
}

// 适配器不携带 Pi 本体：由用户安装的 CLI 找到它所在的 npm 包，SDK 与 CLI 同包同版本。
export function locateHostPi(env: NodeJS.ProcessEnv = process.env): HostPi {
  const command = env.PI_CLI?.trim() || 'pi'
  let cli: string
  try {
    cli = resolveHostCli(command, PI_PACKAGE, 'dist/cli.js', env)
  } catch {
    throw new Error(`宿主 Pi CLI 不可执行或未找到: ${command}；请先安装 Pi，或用 PI_CLI 指定其路径`)
  }
  for (let root = dirname(cli); root !== dirname(root); root = dirname(root)) {
    const pkg = manifest(root)
    if (pkg?.name !== PI_PACKAGE) continue
    return {
      cli,
      root,
      version: pkg.version,
      sdkEntry: importEntry(root),
      aiEntry: importEntry(dependencyRoot(root, '@earendil-works/pi-ai')),
    }
  }
  throw new Error(
    `无法从 ${cli} 定位 Pi 的 npm 包 ${PI_PACKAGE}；Pi 入口需要 npm 安装的 Pi（独立二进制不含可加载的运行时），可用 PI_CLI 指向包内的 dist/cli.js`,
  )
}
