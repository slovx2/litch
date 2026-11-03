import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { verifyPatchBase } from './ci/release-patch-base.mjs'
import { isCompleteReleaseFull } from './full-proof.mjs'
import { readFullProofArtifact } from './full-proof-artifact.mjs'

export function checkNightly({
  nightly,
  fullPassed,
  blockers,
  triage,
  sha,
  releaseCoveragePassed,
}) {
  if (blockers.length)
    throw new Error(`仍有 release-blocker：${blockers.map((issue) => issue.html_url).join(', ')}`)
  if (!nightly) return '尚无夜间 Full 历史；首次接入警告'
  if (nightly.conclusion === 'success') return `夜间 Full 通过：${nightly.html_url}`
  if (releaseCoveragePassed)
    return `夜间仅手机模拟器领域未绿，按用户决定不拦发版；需跟进修复：${nightly.html_url}`
  if (fullPassed)
    return `夜间 ${nightly.conclusion}；同候选 SHA 完整 Full 已通过：${fullPassed.html_url}`
  if (
    triage?.state === 'closed' &&
    triage.labels.some((label) => label.name === 'nightly-triage')
  ) {
    let record
    try {
      record = JSON.parse(triage.body)
    } catch {}
    if (
      record?.candidateSha === sha &&
      record?.nightlyRun === nightly.id &&
      record?.disposition === 'unrelated' &&
      typeof record.reason === 'string' &&
      record.reason.trim().length >= 20 &&
      triage.authorized
    ) {
      return `夜间 ${nightly.conclusion} 已分诊为与本候选无关：${triage.html_url}\n理由：${record.reason}`
    }
  }
  throw new Error(
    `夜间 Full ${nightly.conclusion}：${nightly.html_url}；须同 SHA 完整 Full 成功或有明确分诊记录`,
  )
}

export function checkVersion(tag, latest) {
  const parse = (value) => {
    const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
    if (!match) throw new Error(`正式发布只接受 v主.次.补丁：${value}`)
    return match.slice(1).map(BigInt)
  }
  const candidate = parse(tag)
  if (!latest) return
  const current = parse(latest)
  for (let index = 0; index < 3; index++) {
    if (candidate[index] > current[index]) return
    if (candidate[index] < current[index]) throw new Error(`${tag} 早于最新版 ${latest}，不准晋级`)
  }
  throw new Error(`${tag} 已是公开最新版，不准覆盖公开产物`)
}

function githubApi(path, paginate = false) {
  const result = JSON.parse(
    execFileSync('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  )
  return paginate ? result.flat() : result
}

async function nightlyPolicy(candidateFull, repo, sha, api) {
  const nightly = api(
    `repos/${repo}/actions/workflows/full.yml/runs?event=schedule&status=completed&per_page=1`,
  ).workflow_runs[0]
  // head_sha 是工作流提交，dispatch 的 sha 可覆盖实际检出；只认同次运行的完整证明。
  let fullPassed
  let releaseCoveragePassed = false
  if (nightly && nightly.conclusion !== 'success') {
    const proof = await readFullProofArtifact(repo, nightly, api)
    releaseCoveragePassed = isCompleteReleaseFull(nightly, proof, nightly.head_sha, repo)
    if (!releaseCoveragePassed) {
      if (!candidateFull && process.env.GITHUB_RUN_ID) {
        const run = api(`repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`)
        if (['.github/workflows/release.yml', '.github/workflows/gate.yml'].includes(run.path))
          candidateFull = { run, proof: await readFullProofArtifact(repo, run, api) }
      }
      if (
        candidateFull &&
        isCompleteReleaseFull(candidateFull.run, candidateFull.proof, sha, repo, {
          runningCandidate: true,
          verifiedPreviousAttempt: candidateFull.verifiedPreviousAttempt === true,
        })
      )
        fullPassed = candidateFull.run
      if (!fullPassed) {
        const runs = api(
          `repos/${repo}/actions/workflows/full.yml/runs?status=completed&per_page=100`,
        ).workflow_runs
        for (const run of runs) {
          const fullProof = await readFullProofArtifact(repo, run, api)
          if (isCompleteReleaseFull(run, fullProof, sha, repo)) {
            fullPassed = run
            break
          }
        }
      }
    }
  }
  const blockers = api(`repos/${repo}/issues?labels=release-blocker&state=open&per_page=100`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n候选：\`${sha}\`\n\n最近夜间 Full：${nightly ? `${nightly.conclusion} — ${nightly.html_url}` : '尚无记录（首次接入警告）'}\n`,
    )
  }
  let triage
  if (process.env.NIGHTLY_TRIAGE) {
    if (!/^\d+$/.test(process.env.NIGHTLY_TRIAGE)) throw new Error('分诊输入必须是 issue 编号')
    triage = api(`repos/${repo}/issues/${process.env.NIGHTLY_TRIAGE}`)
    // 分诊必须由有写权限的维护者创建并关闭，不信任任意外部 issue 或评论。
    const allowed = (login) => {
      if (!login) return false
      const permission = api(
        `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      ).permission
      return ['admin', 'maintain', 'write'].includes(permission)
    }
    triage.authorized = allowed(triage.user?.login) && allowed(triage.closed_by?.login)
  }
  let message
  try {
    message = checkNightly({ nightly, fullPassed, blockers, triage, sha, releaseCoveragePassed })
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n阻断：${error.message}\n`)
    throw error
  }
  console.log(message)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`)
  }
  return message
}

export async function releasePolicy(
  { candidateFull, allowMissingTag = false, gate, branch, version } = {},
  services = {},
) {
  const api = services.api ?? githubApi
  const repo = process.env.GITHUB_REPOSITORY
  const sha = process.env.CANDIDATE_SHA
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('缺少完整候选 SHA')
  const mode = gate?.mode ?? 'standard'
  if (!['standard', 'patch'].includes(mode)) throw new Error('未知发版模式')
  let message
  if (mode === 'patch') {
    const blockers = api(
      `repos/${repo}/issues?labels=release-blocker&state=open&per_page=100`,
      true,
    )
    if (blockers.length) throw new Error('仍有 release-blocker，禁止修复版发布')
    const base = (services.verifyPatchBase ?? verifyPatchBase)({
      repository: repo,
      sha,
      version: version ?? gate.baseline?.candidateVersion,
      branch,
      tag: gate.baseline?.tag,
      expected: gate.baseline,
    })
    message = `修复版基线：${base.url}；${base.commits.length} 个线性提交；不依赖夜间分诊`
    console.log(message)
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`)
  } else message = await nightlyPolicy(candidateFull, repo, sha, api)
  if (process.env.TAG) {
    const refs = api(`repos/${repo}/git/matching-refs/tags/${encodeURIComponent(process.env.TAG)}`)
    const exists = refs.some((ref) => ref.ref === `refs/tags/${process.env.TAG}`)
    if (!exists && !allowMissingTag) throw new Error('标签不存在')
    if (exists) {
      const tagSha = api(
        `repos/${repo}/commits/${encodeURIComponent(`refs/tags/${process.env.TAG}`)}`,
      ).sha
      if (tagSha !== sha) throw new Error('标签已移动，与冻结的候选 SHA 不同')
    }
    // releases 列表不会把草稿当最新版。按 GitHub latest API 的实际选择核对。
    const releases = api(`repos/${repo}/releases?per_page=100`, true)
    const published = releases.filter((release) => !release.draft && !release.prerelease)
    if (releases.some((release) => release.tag_name === process.env.TAG && !release.draft)) {
      throw new Error('该版本已经公开，禁止覆盖')
    }
    if (published.length) {
      checkVersion(process.env.TAG, api(`repos/${repo}/releases/latest`).tag_name)
      // 同时防止 latest 标记曾被手工设旧时继续倒退。
      for (const release of published) checkVersion(process.env.TAG, release.tag_name)
    } else checkVersion(process.env.TAG)
  }
  return message
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await releasePolicy()
