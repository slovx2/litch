// 修复版只信任最新公开正式版，不能把任意标签或红夜间当成增量基线。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gh } from './release-artifacts.mjs'

const shaPattern = /^[a-f0-9]{40}$/
const digestPattern = /^sha256:[a-f0-9]{64}$/
export const patchCommitLimit = 5

function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '')
  assert.ok(match, '修复版必须使用正式三段版本')
  return match.slice(1).map(BigInt)
}

export function checkPatchRecord(base, { repository, sha, version } = {}) {
  assert.equal(base?.kind, 'release', '修复版缺少正式发布基线')
  assert.equal(base.repository, repository, '基线仓库')
  assert.match(base.sha ?? '', shaPattern, '基线 SHA')
  assert.match(base.candidateSha ?? '', shaPattern, '修复候选 SHA')
  assert.equal(base.candidateSha, sha, '基线绑定的候选 SHA')
  const oldVersion = versionParts(base.version)
  const nextVersion = versionParts(base.candidateVersion)
  assert.equal(base.tag, `v${base.version}`, '基线标签')
  assert.ok(
    nextVersion[0] === oldVersion[0] &&
      nextVersion[1] === oldVersion[1] &&
      nextVersion[2] === oldVersion[2] + 1n,
    '快速模式只允许同主次版本的下一补丁版本',
  )
  if (version !== undefined) assert.equal(base.candidateVersion, version, '候选版本')
  assert.equal(base.branch, `release/${base.candidateVersion}`, '修复候选分支')
  assert.ok(Number.isSafeInteger(base.releaseId) && base.releaseId > 0, '正式 Release ID')
  assert.ok(Number.isSafeInteger(base.asset?.id) && base.asset.id > 0, '基线清单资产 ID')
  assert.match(base.asset.digest ?? '', digestPattern, '基线清单摘要')
  assert.ok(Number.isSafeInteger(base.run) && base.run > 0, '基线 Prepare run')
  assert.ok(Number.isSafeInteger(base.attempt) && base.attempt > 0, '基线 Prepare attempt')
  assert.ok(
    Array.isArray(base.commits) &&
      base.commits.length >= 1 &&
      base.commits.length <= patchCommitLimit,
    '修复版只允许 1–5 个提交',
  )
  assert.equal(new Set(base.commits).size, base.commits.length, '重复提交')
  for (const commit of base.commits) assert.match(commit, shaPattern, '修复提交 SHA')
  assert.equal(base.commits.at(-1), sha, '修复提交链末端')
  return base
}

export function checkPatchHistory(compare, baseSha, sha) {
  assert.equal(compare.status, 'ahead', '候选必须从正式基线派生')
  assert.equal(compare.behind_by, 0, '候选不能落后基线')
  assert.equal(compare.merge_base_commit?.sha, baseSha, '基线必须是候选祖先')
  assert.ok(
    Number.isSafeInteger(compare.total_commits) &&
      compare.total_commits >= 1 &&
      compare.total_commits <= patchCommitLimit,
    '修复版只允许 1–5 个提交',
  )
  assert.equal(compare.commits?.length, compare.total_commits, '提交列表被截断')
  let parent = baseSha
  for (const commit of compare.commits) {
    assert.deepEqual(
      commit.parents?.map((item) => item.sha),
      [parent],
      '修复版必须线性且不含 merge',
    )
    parent = commit.sha
  }
  assert.equal(parent, sha, '修复历史末端')
  return compare.commits.map((commit) => commit.sha)
}

// 首次准备和临公开都重新核对；已封存的身份字段必须完全一致。
export function verifyPatchBase(input, services = {}) {
  const { repository, sha, version, branch, tag, expected } = input
  const api = services.api ?? ((path) => JSON.parse(gh(['api', path], { timeout: 45000 })))
  const readAsset =
    services.readAsset ??
    ((path) =>
      gh(['api', path, '-H', 'Accept: application/octet-stream'], {
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
      }))
  assert.match(tag ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '修复基线标签')
  assert.match(sha ?? '', shaPattern, '候选 SHA')
  const root = `repos/${repository}`
  assert.equal(
    api(`${root}/issues?labels=release-blocker&state=open&per_page=100`).length,
    0,
    '仍有 release-blocker，禁止修复版发布',
  )
  const release = api(`${root}/releases/latest`)
  assert.equal(release.tag_name, tag, '修复基线必须是当前最新正式版')
  assert.equal(release.draft, false, '基线必须已公开')
  assert.equal(release.prerelease, false, '基线不能是预发布')
  assert.ok(release.published_at, '基线缺少公开时间')
  const baseSha = api(`${root}/commits/${encodeURIComponent(`refs/tags/${tag}`)}`).sha
  const assets = api(`${root}/releases/${release.id}/assets?per_page=100`).filter(
    (asset) => asset.name === 'candidate.json',
  )
  assert.equal(assets.length, 1, '公开基线必须有唯一的封存候选清单')
  const asset = assets[0]
  assert.match(asset.digest ?? '', digestPattern, '公开基线清单缺少摘要')
  assert.ok(asset.size > 0 && asset.size <= 2 * 1024 * 1024, '基线清单大小')
  const raw = readAsset(`${root}/releases/assets/${asset.id}`)
  assert.equal(Buffer.byteLength(raw), asset.size, '基线清单大小不符')
  assert.equal(
    `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    asset.digest,
    '基线清单摘要不符',
  )
  const manifest = JSON.parse(raw)
  assert.equal(manifest.schema, 2, '基线候选清单 schema')
  assert.equal(manifest.repository, repository, '基线候选仓库')
  assert.equal(manifest.sha, baseSha, '正式标签已偏离发布候选')
  assert.equal(manifest.version, tag.slice(1), '基线版本')
  assert.equal(manifest.gate?.sha, baseSha, '基线 Gate SHA')
  assert.equal(manifest.gate?.conclusion, 'success', '基线 Gate 必须成功')
  const run = api(`${root}/actions/runs/${manifest.runId}`)
  assert.equal(run.repository?.full_name, repository, '基线运行仓库')
  assert.equal(run.path, '.github/workflows/release.yml', '基线来源必须是 Prepare')
  assert.equal(run.event, 'workflow_dispatch', '基线运行事件')
  assert.equal(run.head_sha, baseSha, '基线运行 SHA')
  assert.equal(run.status, 'completed', '基线 Prepare 未结束')
  assert.equal(run.conclusion, 'success', '基线 Prepare 未通过')
  assert.equal(run.run_attempt, manifest.attempt, '基线 Prepare attempt 已变化')
  const contents = api(`${root}/contents/package.json?ref=${sha}`)
  assert.equal(JSON.parse(Buffer.from(contents.content, 'base64')).version, version, '候选源码版本')
  const compare = api(`${root}/compare/${baseSha}...${sha}`)
  const base = checkPatchRecord(
    {
      kind: 'release',
      repository,
      tag,
      sha: baseSha,
      version: manifest.version,
      releaseId: release.id,
      url: release.html_url,
      asset: { id: asset.id, digest: asset.digest },
      run: Number(manifest.runId),
      attempt: manifest.attempt,
      candidateSha: sha,
      candidateVersion: version,
      branch,
      commits: checkPatchHistory(compare, baseSha, sha),
    },
    { repository, sha, version },
  )
  if (expected) assert.deepEqual(base, expected, '正式基线或修复历史已变化，须重新准备候选')
  return base
}
