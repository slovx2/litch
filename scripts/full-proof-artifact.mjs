import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 名字含 attempt，不能用上一次尝试的 artifact 给新尝试背书。
export async function readFullProofArtifact(repo, run, api, download = downloadArchive) {
  const listed = api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts
  const matches = listed.filter(
    (artifact) => artifact.name === `full-proof-${run.run_attempt}` && !artifact.expired,
  )
  if (matches.length !== 1) return undefined
  const artifact = matches[0]
  if (
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.size_in_bytes > 128 * 1024
  )
    return undefined
  return download(repo, artifact.id)
}

async function downloadArchive(repo, id) {
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`读取 Full 证明失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return decodeFullProofArchive(buffer)
}

export function decodeFullProofArchive(buffer) {
  if (buffer.length > 128 * 1024) throw new Error('Full 证明超出大小上限')
  const temp = mkdtempSync(join(tmpdir(), 'litch-full-proof-'))
  try {
    const archive = join(temp, 'proof.zip')
    writeFileSync(archive, buffer)
    // 不解包任何路径，只读取唯一的 JSON，拒绝其他文件和路径穿越。
    const files = execFileSync('unzip', ['-Z1', archive], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
    }).trim()
    if (files !== 'full-proof.json') throw new Error('Full 证明 archive 内容不符')
    return JSON.parse(
      execFileSync('unzip', ['-p', archive, 'full-proof.json'], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024,
      }),
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
