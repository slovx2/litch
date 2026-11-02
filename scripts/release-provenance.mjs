// 每个平台在上传前为实际产物写 SHA 与 hash；晋级时只认本次运行的这五份清单。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const artifactKinds = ['adapter', 'cha', 'desktop-macos', 'desktop-windows', 'android']
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

export function writeProvenance(
  dir,
  kind,
  sha,
  run,
  attempt = process.env.GITHUB_RUN_ATTEMPT,
  checkpoint,
) {
  if (!artifactKinds.includes(kind) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('产物来源参数错误')
  const files = readdirSync(dir).filter((name) => !name.startsWith('release-provenance-'))
  if (!files.length) throw new Error('产物目录为空')
  const proof = {
    schema: 2,
    kind,
    sha,
    run,
    attempt,
    signing: ['desktop-macos', 'android'].includes(kind) ? 'release' : 'not-required',
    files: Object.fromEntries(files.map((file) => [file, hash(join(dir, file))])),
    ...(checkpoint ? { notarization: checkpoint } : {}),
  }
  writeFileSync(join(dir, `release-provenance-${kind}.json`), JSON.stringify(proof, null, 2))
  return proof
}

export function verifyProvenance(dir, sha, run) {
  const gate = JSON.parse(readFileSync(join(dir, 'gate-proof.json'), 'utf8'))
  if (gate.sha !== sha || gate.run !== run || gate.conclusion !== 'success')
    throw new Error('门禁与候选 SHA/运行不符')
  const covered = new Set()
  for (const kind of artifactKinds) {
    const proof = JSON.parse(readFileSync(join(dir, `release-provenance-${kind}.json`), 'utf8'))
    if (proof.schema !== 2 || proof.kind !== kind || proof.sha !== sha || proof.run !== run)
      throw new Error(`${kind} 来源与候选不符`)
    if (!Object.keys(proof.files).length) throw new Error(`${kind} 无产物`)
    for (const [name, expected] of Object.entries(proof.files)) {
      if (basename(name) !== name || covered.has(name))
        throw new Error(`重复或越界的产物名：${name}`)
      if (hash(join(dir, name)) !== expected) throw new Error(`${kind}/${name} hash 不符`)
      covered.add(name)
    }
  }
  for (const file of readdirSync(dir)) {
    if (
      file === 'gate-proof.json' ||
      artifactKinds.some((kind) => file === `release-provenance-${kind}.json`)
    )
      continue
    if (!covered.has(file)) throw new Error(`未在来源清单登记的产物：${file}`)
  }
  return covered.size
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dir, kind] = process.argv.slice(2)
  const sha = process.env.CANDIDATE_SHA
  if (mode === 'write') {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (sha !== head) throw new Error('检出的代码不是冻结的候选 SHA')
    const checkpoint =
      kind === 'desktop-macos'
        ? JSON.parse(readFileSync(process.env.MACOS_VALIDATED_CHECKPOINT, 'utf8'))
        : undefined
    writeProvenance(
      dir,
      kind,
      sha,
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_RUN_ATTEMPT,
      checkpoint,
    )
  } else if (mode === 'verify') {
    console.log(
      `已核对 ${verifyProvenance(dir, sha, process.env.SOURCE_RUN || process.env.GITHUB_RUN_ID)} 份同 SHA 产物`,
    )
  } else throw new Error('用法：release-provenance.mjs write|verify DIR [KIND]')
}
