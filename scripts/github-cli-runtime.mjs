// 只分发 GitHub CLI 官方制品。暂存顺序是取固定版本清单、校验压缩包、提取指定的两个文件。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const GITHUB_CLI_VERSION = '2.102.0'
const base = `gh_${GITHUB_CLI_VERSION}`
const release = `https://github.com/cli/cli/releases/download/v${GITHUB_CLI_VERSION}`
const manifest = `${base}_checksums.txt`
const cache = fileURLToPath(new URL('../apps/desktop/.cache/github-cli/', import.meta.url))

export function githubCliArchive(platform, arch) {
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch]
  const os = { darwin: 'macOS', linux: 'linux', win32: 'windows' }[platform]
  if (!cpu || !os) throw new Error(`GitHub CLI 没有登记 ${platform}-${arch} 的制品`)
  return `${base}_${os}_${cpu}.${platform === 'linux' ? 'tar.gz' : 'zip'}`
}

export function githubCliChecksum(list, filename) {
  const matches = list.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-f0-9]{64})[ \t]+\*?(\S+)$/.exec(line.trim())
    return match?.[2] === filename ? [match[1]] : []
  })
  if (matches.length !== 1) throw new Error(`GitHub CLI 校验清单没有唯一的 ${filename} 条目`)
  return matches[0]
}

async function download(name, path) {
  const response = await fetch(`${release}/${name}`, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok || !response.body)
    throw new Error(`下载 GitHub CLI 的 ${name} 失败：HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: 'wx' }))
}

async function digest(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const flights = new Map()
async function cached(name, expected) {
  const path = join(cache, name)
  const check = async (path) =>
    expected ? (await digest(path)) === expected : (await readFile(path)).byteLength < 64 * 1024
  if (await check(path).catch(() => false)) return path
  await mkdir(cache, { recursive: true })
  const partial = `${path}.${process.pid}.partial`
  try {
    await download(name, partial)
    if (!(await check(partial))) throw new Error(`${name} 的 SHA-256 校验失败`)
    await rename(partial, path)
    return path
  } finally {
    await rm(partial, { force: true })
  }
}

function fetchCached(name, expected) {
  if (!flights.has(name))
    flights.set(
      name,
      cached(name, expected).finally(() => flights.delete(name)),
    )
  return flights.get(name)
}

function extract(archive, relative) {
  const program =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  // Linux 的 GNU tar 不读 zip；交叉暂存 Windows 则用 unzip。两条路径都只读指定成员。
  const zip = archive.endsWith('.zip') && process.platform === 'linux'
  const opts = { maxBuffer: 80 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  const list = execFileSync(
    zip ? 'unzip' : program,
    zip ? ['-Z1', archive] : ['-tf', archive],
    opts,
  )
    .toString()
    .split(/\r?\n/)
  const matches = list.filter(
    (name) =>
      name === relative ||
      (name.startsWith(`${base}_`) && name.slice(name.indexOf('/') + 1) === relative),
  )
  if (matches.length !== 1) throw new Error(`GitHub CLI 压缩包没有唯一的 ${relative}`)
  return execFileSync(
    zip ? 'unzip' : program,
    zip ? ['-p', archive, matches[0]] : ['-xOf', archive, matches[0]],
    opts,
  )
}

export async function installGithubCli(runtimeRoot, { platform, arch }) {
  const name = githubCliArchive(platform, arch)
  const sums = await readFile(await fetchCached(manifest), 'utf8')
  const expected = githubCliChecksum(sums, name)
  const archive = await fetchCached(name, expected)
  return installGithubCliArchive(runtimeRoot, { platform, arch, archive, expected })
}

/** 归档必须先完成校验，再创建受管路径；测试也走这一段。 */
export async function installGithubCliArchive(runtimeRoot, { platform, arch, archive, expected }) {
  const name = githubCliArchive(platform, arch)
  if (!/^[a-f0-9]{64}$/.test(expected) || (await digest(archive)) !== expected)
    throw new Error(`${name} 的 SHA-256 校验失败`)
  const target = join(runtimeRoot, 'tools', 'github-cli', GITHUB_CLI_VERSION, `${platform}-${arch}`)
  const executable = platform === 'win32' ? 'gh.exe' : 'gh'
  const binary = join(target, 'bin', executable)
  const content = extract(archive, `bin/${executable}`)
  const license = extract(archive, 'LICENSE')
  await mkdir(join(target, 'bin'), { recursive: true })
  await writeFile(binary, content, { mode: 0o755, flag: 'wx' })
  if (process.platform !== 'win32') await chmod(binary, 0o755)
  await writeFile(join(target, 'LICENSE'), license, { flag: 'wx' })
  return binary
}
