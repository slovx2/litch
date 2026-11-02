// 只读 GitHub 元数据和不可变 artifact；拒绝路径穿越、同名覆盖和摘要缺失。
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
}

export function api(path, fields) {
  return JSON.parse(
    gh(
      ['api', path, ...(fields ? ['--method', 'POST', '--input', '-'] : [])],
      fields ? { input: JSON.stringify(fields) } : {},
    ),
  )
}

export function pages(path, key) {
  return JSON.parse(gh(['api', '--paginate', '--slurp', path])).flatMap((page) =>
    key ? page[key] : page,
  )
}

export async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function validateArtifact(artifact, { run, sha, name, digest }) {
  if (
    !Number.isSafeInteger(artifact?.id) ||
    artifact.expired ||
    artifact.name !== name ||
    artifact.workflow_run?.id !== Number(run) ||
    artifact.workflow_run?.head_sha !== sha ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') ||
    (digest && artifact.digest !== digest)
  )
    throw new Error('artifact 来源、摘要、名字或有效期不符')
  return artifact
}

export async function download(
  url,
  path,
  token,
  limit = 8 * 1024 ** 3,
  accept = 'application/vnd.github+json',
) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: accept } : {},
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  let bytes = 0
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > limit ? new Error('下载超过大小上限') : null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(path, { flags: 'wx' }))
}

export function archiveNames(archive) {
  const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 })
    .trim()
    .split('\n')
  if (
    !names.length ||
    names.length > 100 ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
  )
    throw new Error('archive 必须是唯一的平铺文件，禁止路径或通配字符')
  return names
}

export async function extractFlat(archive, directory) {
  // 逐文件读取成普通文件，绝不恢复 zip 里的符号链接或权限。
  for (const name of archiveNames(archive)) {
    const target = join(directory, name)
    if (existsSync(target)) throw new Error(`artifact 文件冲突：${name}`)
    const child = spawn('unzip', ['-p', archive, name], { stdio: ['ignore', 'pipe', 'pipe'] })
    const finished = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`解包失败：${name}`))))
    })
    child.stderr.resume()
    let size = 0
    const bounded = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        callback(size > 8 * 1024 ** 3 ? new Error('解包超过大小上限') : null, chunk)
      },
    })
    try {
      await Promise.all([
        finished,
        pipeline(child.stdout, bounded, createWriteStream(target, { flags: 'wx' })),
      ])
    } finally {
      child.kill()
    }
  }
}

export async function downloadArtifact(repo, artifact, directory) {
  const temp = mkdtempSync(join(tmpdir(), 'litch-artifact-'))
  try {
    const archive = join(temp, 'artifact.zip')
    await download(
      `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
      archive,
      process.env.GH_TOKEN,
    )
    if (`sha256:${await fileHash(archive)}` !== artifact.digest)
      throw new Error('artifact archive hash 不符')
    await extractFlat(archive, directory)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
