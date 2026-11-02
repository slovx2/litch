import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function checkNightly({ nightly, fullPassed, blockers, triage, sha }) {
  if (blockers.length)
    throw new Error(`仍有 release-blocker：${blockers.map((issue) => issue.html_url).join(', ')}`)
  if (!nightly) return '尚无夜间 Full 历史；首次接入警告'
  if (nightly.conclusion === 'success') return `夜间 Full 通过：${nightly.html_url}`
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

function api(path, paginate = false) {
  const result = JSON.parse(
    execFileSync('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  )
  return paginate ? result.flat() : result
}

export function releasePolicy() {
  const repo = process.env.GITHUB_REPOSITORY
  const sha = process.env.CANDIDATE_SHA
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('缺少完整候选 SHA')
  const nightly = api(
    `repos/${repo}/actions/workflows/full.yml/runs?event=schedule&status=completed&per_page=1`,
  ).workflow_runs[0]
  const fullPassed = api(
    `repos/${repo}/actions/workflows/full.yml/runs?head_sha=${sha}&status=success&per_page=100`,
  ).workflow_runs.find(
    (run) => ['workflow_dispatch', 'schedule'].includes(run.event) && run.head_sha === sha,
  )
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
    message = checkNightly({ nightly, fullPassed, blockers, triage, sha })
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n阻断：${error.message}\n`)
    throw error
  }
  console.log(message)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`)
  }
  if (process.env.TAG) {
    const tagSha = api(`repos/${repo}/commits/${encodeURIComponent(process.env.TAG)}`).sha
    if (tagSha !== sha) throw new Error('标签已移动，与冻结的候选 SHA 不同')
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) releasePolicy()
