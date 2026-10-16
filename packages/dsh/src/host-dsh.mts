import { execFileSync } from 'node:child_process'
import { cliCommand, resolveHostCli } from '../../shared/src/host-cli.mjs'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'

// dsh 本体不随适配器分发：使用用户自己安装的可执行文件，默认从 PATH 查找，CHA_DSH_CLI 可指定路径。
export function hostDshExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const command = env.CHA_DSH_CLI?.trim() || 'dsh'
  try {
    return resolveHostCli(command, '@deepseek-ai/dsh', 'lib/bin.js', env)
  } catch {
    throw new Error(
      `宿主 dsh CLI 不可执行或未找到: ${command}；请先安装 DeepSeek Harness，或配置 CHA_DSH_CLI 或当前用户 PATH`,
    )
  }
}

const SEMVER = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/

// 预发布标识按 semver 逐段比较：数字段按数值，其余按字典序，数字段低于非数字段，段数少者低。
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)]
    if (numeric[0] && numeric[1]) return Number(x) - Number(y)
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

// 共用的下限判断只接受稳定版；dsh 目前只有预发布版，下限本身落在预发布号上，所以这里补上预发布的比较：
// 核心版本不同时沿用共用规则，核心版本相同时稳定版高于预发布版，同为预发布版再逐段比较。
export function dshVersionAtLeast(actual: string | undefined, minimum: string): boolean {
  const a = SEMVER.exec(actual ?? '')
  const m = SEMVER.exec(minimum)
  if (!a?.[1] || !m?.[1]) return false
  if (a[1] !== m[1]) return isVersionAtLeast(a[1], m[1])
  if (!a[2]) return true
  if (!m[2]) return false
  return comparePrerelease(a[2], m[2]) >= 0
}

// 读取用户安装的 dsh 版本并核对下限，返回裸版本号。
export function hostDshVersion(cli: string, minimum: string): string {
  let output: string
  try {
    const [command, ...args] = cliCommand(cli, ['--version'])
    output = execFileSync(command as string, args, { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    throw new Error(`无法读取宿主 dsh CLI 版本: ${cli}`)
  }
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0]
  if (!dshVersionAtLeast(version, minimum))
    throw new Error(`宿主 dsh CLI 版本不符: 需要 >= ${minimum}，实际 ${output.slice(0, 80)}`)
  return version as string
}
