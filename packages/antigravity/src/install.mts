import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import lock from './artifacts.json' with { type: 'json' }
import { wheelMember } from './wheel.mjs'

export interface Artifact {
  url: string
  wheelSha256: string
  binarySha256: string
  schemaSha256: string
  member: string
}
export const SDK_VERSION = lock.version
export const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
export function artifactFor(platform = process.platform, arch = process.arch): Artifact {
  const artifact = (lock.artifacts as Record<string, Artifact>)[`${platform}-${arch}`]
  if (!artifact) throw new Error(`localharness 暂不支持 ${platform}/${arch}`)
  return artifact
}
export async function verifyBinary(path: string, artifact = artifactFor()): Promise<void> {
  if (!(await stat(path)).isFile() || digest(await readFile(path)) !== artifact.binarySha256)
    throw new Error('localharness SHA-256 不符；请删除指定路径配置或重新安装固定版本')
}
const installs = new Map<string, Promise<string>>()
export function ensureRuntime(home: string, explicit?: string): Promise<string> {
  const artifact = artifactFor()
  if (explicit) return verifyBinary(explicit, artifact).then(() => explicit)
  const path = join(home, 'runtime', SDK_VERSION, `${process.platform}-${process.arch}`)
  let pending = installs.get(path)
  if (!pending) {
    pending = installArtifact(path, artifact).finally(() => installs.delete(path))
    installs.set(path, pending)
  }
  return pending
}
export async function installArtifact(
  directory: string,
  artifact: Artifact,
  download: typeof fetch = fetch,
): Promise<string> {
  const filename = artifact.member.endsWith('.exe') ? 'localharness.exe' : 'localharness'
  const binary = join(directory, filename)
  try {
    await verifyBinary(binary, artifact)
    return binary
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 不使用浮动 PyPI 查询、不跟随重定向。下载源和两个文件摘要由发布审查固定。
  if (new URL(artifact.url).origin !== 'https://files.pythonhosted.org')
    throw new Error('localharness 下载源必须为官方 PyPI')
  const response = await download(artifact.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok || !response.body)
    throw new Error(`localharness 下载失败（HTTP ${response.status}），请检查网络后重试`)
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > 64 * 1024 * 1024) throw new Error('localharness 下载包超出大小限制')
    chunks.push(chunk)
  }
  const archive = Buffer.concat(chunks)
  if (digest(archive) !== artifact.wheelSha256)
    throw new Error('localharness 下载校验失败（wheel SHA-256），未安装')
  const bytes = wheelMember(archive, artifact.member)
  const schema = wheelMember(archive, 'google/antigravity/proto/localharness_pb2.py')
  if (digest(bytes) !== artifact.binarySha256 || digest(schema) !== artifact.schemaSha256)
    throw new Error('localharness 程序或 schema 校验失败，未安装')
  const license = wheelMember(
    archive,
    `google_antigravity-${SDK_VERSION}.dist-info/licenses/LICENSE`,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.download-${randomUUID()}`)
  try {
    await writeFile(temporary, bytes, { mode: 0o700, flag: 'wx' })
    await chmod(temporary, 0o700)
    await writeFile(join(directory, 'LICENSE'), license, { mode: 0o600 })
    await rename(temporary, binary)
  } finally {
    await rm(temporary, { force: true })
  }
  return binary
}
