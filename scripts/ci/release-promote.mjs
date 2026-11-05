// Promote 只下载、校验和晋级；这里没有测试、编译、签名或公证命令。
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkCheckpointJob } from '../../apps/desktop/scripts/macos-checkpoint.mjs'
import { releasePolicy as defaultPolicy } from '../release-policy.mjs'
import {
  api as defaultApi,
  downloadArtifact as defaultArtifactDownload,
  download as defaultDownload,
  gh as defaultGh,
  pages as defaultPages,
  fileHash,
  validateArtifact,
} from './release-artifacts.mjs'
import {
  checkJob,
  checkNotarization,
  policyHash as defaultPolicyHash,
  inventory,
  readJson,
  sourceRun,
  summary,
  verifyCandidate,
  writeJson,
} from './release-candidate.mjs'

export function promotionInputs(env) {
  for (const key of ['SOURCE_RUN', 'SOURCE_ATTEMPT', 'ARTIFACT_ID'])
    assert.match(env[key] ?? '', /^[1-9][0-9]*$/, key)
  assert.match(env.CANDIDATE_SHA ?? '', /^[a-f0-9]{40}$/, 'candidate SHA')
  assert.match(env.ARTIFACT_DIGEST ?? '', /^sha256:[a-f0-9]{64}$/, 'artifact digest')
  assert.match(env.TAG ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'tag')
  assert.ok(['verify', 'draft', 'publish'].includes(env.PROMOTE_MODE), 'mode')
  if (env.PROMOTE_MODE === 'publish')
    assert.equal(
      env.CONFIRM_PUBLICATION,
      env.TAG,
      '公开须明确输入目标标签，代表维护者已取得用户授权并审阅验收',
    )
  return {
    repository: env.GITHUB_REPOSITORY,
    sha: env.CANDIDATE_SHA,
    runId: env.SOURCE_RUN,
    attempt: Number(env.SOURCE_ATTEMPT),
    version: env.TAG.slice(1),
  }
}

export function checkDraft(release, tag, marker) {
  if (!release) return
  assert.equal(release.tag_name, tag, 'draft tag')
  assert.equal(release.draft, true, '禁止覆盖已公开版本')
  assert.equal(release.prerelease, false, '禁止预发布')
  assert.ok(release.body?.includes(marker), '草稿不属于这个候选，禁止覆盖')
}

export function releaseNotes(changelog, version) {
  const sections = [...changelog.matchAll(/^## ([^\r\n]+)\r?$/gm)]
  const matches = sections.filter(
    (section) => /^(\d+\.\d+\.\d+)(?=$|[\s（(])/.exec(section[1])?.[1] === version,
  )
  assert.equal(matches.length, 1, `CHANGELOG 必须且只能包含一个 ${version} 条目`)
  const section = matches[0]
  const next = sections[sections.indexOf(section) + 1]
  const body = changelog.slice(section.index + section[0].length, next?.index).trim()
  assert.ok(body, `CHANGELOG 的 ${version} 发布说明不能为空`)
  return body
}

export function checkAssets(assets, expected, { complete = true } = {}) {
  const seen = new Set()
  for (const asset of assets) {
    assert.ok(!seen.has(asset.name) && expected[asset.name], '多余或重名资产')
    seen.add(asset.name)
    assert.equal(asset.state, 'uploaded', '上传未完成')
    assert.equal(asset.size, expected[asset.name].size, '资产大小不符')
    // 没有服务端摘要时仍必须下载回验；有摘要时提前拒绝冲突。
    if (asset.digest)
      assert.equal(asset.digest, `sha256:${expected[asset.name].sha256}`, '资产摘要不符')
  }
  if (complete) assert.deepEqual([...seen].sort(), Object.keys(expected).sort(), '资产缺失')
}

export async function promote(env = process.env, services = {}) {
  const {
    api = defaultApi,
    pages = defaultPages,
    gh = defaultGh,
    download = defaultDownload,
    downloadArtifact = defaultArtifactDownload,
    releasePolicy = defaultPolicy,
    policyHash = defaultPolicyHash,
  } = services
  const context = promotionInputs(env)
  const repo = context.repository
  const base = `repos/${repo}`
  const runPath = `${base}/actions/runs/${context.runId}`
  const run = api(runPath)
  sourceRun(run, context)
  const artifact = validateArtifact(api(`${base}/actions/artifacts/${env.ARTIFACT_ID}`), {
    run: context.runId,
    sha: context.sha,
    name: `verified-candidate-${context.attempt}`,
    digest: env.ARTIFACT_DIGEST,
  })
  const work = mkdtempSync(join(tmpdir(), 'litch-promote-'))
  try {
    const dir = join(work, 'candidate')
    mkdirSync(dir)
    await downloadArtifact(repo, artifact, dir)
    const manifest = await verifyCandidate(dir, context, policyHash())
    const latestJobs = pages(`${runPath}/jobs?filter=latest&per_page=100`, 'jobs')
    checkJob(
      pages(`${runPath}/attempts/${context.attempt}/jobs?per_page=100`, 'jobs'),
      'seal',
      context.attempt,
    )
    for (const [kind, source] of Object.entries(manifest.artifacts)) {
      const name =
        kind === 'gate-proof'
          ? 'gate / result'
          : kind === 'full-proof'
            ? 'gate / tests / report'
            : kind
      validateArtifact(api(`${base}/actions/artifacts/${source.id}`), {
        run: context.runId,
        sha: context.sha,
        name: source.name,
        digest: source.digest,
      })
      const id = checkJob(
        pages(`${runPath}/attempts/${source.attempt}/jobs?per_page=100`, 'jobs'),
        name,
        source.attempt,
      )
      assert.equal(id, source.jobId, '来源 job ID')
      assert.ok(
        latestJobs.some((job) => job.name === name && job.conclusion === 'success'),
        '最新 job 未通过',
      )
    }
    const notarization = checkNotarization(
      readJson(join(dir, 'release-provenance-desktop-macos.json')),
      context,
    )
    validateArtifact(api(`${base}/actions/artifacts/${notarization.artifact.id}`), {
      run: context.runId,
      sha: context.sha,
      name: notarization.artifact.name,
      digest: notarization.artifact.digest,
    })
    checkCheckpointJob(
      pages(`${runPath}/attempts/${notarization.attempt}/jobs?per_page=100`, 'jobs'),
      notarization.attempt,
    )
    const candidateFull = { run, proof: manifest.full, verifiedPreviousAttempt: true }
    const policyContext = {
      candidateFull,
      gate: manifest.gate,
      branch: run.head_branch,
      version: context.version,
    }
    await releasePolicy({ ...policyContext, allowMissingTag: true })
    const marker = `<!-- litch-candidate:${context.runId}:${context.attempt}:${artifact.id}:${artifact.digest} -->`
    const report = `${summary(manifest)}\n封存 artifact：${artifact.id}，${artifact.digest}\n`
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, report)
    // 按候选 SHA 读取已审阅文案，不能取晋级工作流所在分支或 GitHub 自动提交摘要。
    const changelog = api(`${base}/contents/CHANGELOG.md?ref=${context.sha}`)
    assert.equal(changelog.encoding, 'base64', '无法读取候选 CHANGELOG')
    const notes = releaseNotes(
      Buffer.from(changelog.content, 'base64').toString('utf8'),
      context.version,
    )
    const body = `${notes}\n\n${marker}`
    if (env.PROMOTE_MODE === 'verify')
      return { mode: 'verify', sha: context.sha, artifact: artifact.id }

    // 只有明确的 draft/publish 操作创建标签，已有标签必须完全相同；不 force。
    const refs = api(`${base}/git/matching-refs/tags/${env.TAG}`)
    if (!refs.some((ref) => ref.ref === `refs/tags/${env.TAG}`))
      api(`${base}/git/refs`, { ref: `refs/tags/${env.TAG}`, sha: context.sha })
    await releasePolicy(policyContext)
    const existing = pages(`${base}/releases?per_page=100`).filter(
      (item) => item.tag_name === env.TAG,
    )
    assert.ok(existing.length <= 1, '同标签存在多个 release')
    let release = existing[0]
    checkDraft(release, env.TAG, marker)
    if (release) assert.equal(release.body, body, '草稿正文与候选 CHANGELOG 不一致')
    if (!release) {
      release = api(`${base}/releases`, {
        tag_name: env.TAG,
        target_commitish: context.sha,
        name: env.TAG,
        body,
        draft: true,
        prerelease: false,
        make_latest: 'false',
      })
    }
    const expected = await inventory(dir)
    const assetPath = `${base}/releases/${release.id}/assets?per_page=100`
    const before = pages(assetPath)
    checkAssets(before, expected, { complete: false })
    const missing = Object.keys(expected).filter(
      (name) => !before.some((asset) => asset.name === name),
    )
    if (missing.length)
      gh(['release', 'upload', env.TAG, '--repo', repo, ...missing.map((name) => join(dir, name))])
    const assets = pages(assetPath)
    checkAssets(assets, expected)
    for (const asset of assets) {
      const path = join(work, `asset-${asset.id}`)
      await download(
        `https://api.github.com/${base}/releases/assets/${asset.id}`,
        path,
        env.GH_TOKEN,
        undefined,
        'application/octet-stream',
      )
      assert.equal(await fileHash(path), expected[asset.name].sha256, `下载回验失败：${asset.name}`)
    }
    // Homebrew 用的是标签源码 tar，而不是安装包；取真实 URL 的 bytes 计算，不伪造 hash。
    const tarPath = join(work, 'source.tar.gz')
    const sourceUrl = `https://github.com/${repo}/archive/refs/tags/${env.TAG}.tar.gz`
    await download(sourceUrl, tarPath)
    const tap = {
      repository: 'slovx2/homebrew-tap',
      formula: 'Formula/codex-harness-adapter.rb',
      version: context.version,
      tag: env.TAG,
      sha: context.sha,
      url: sourceUrl,
      sha256: await fileHash(tarPath),
      title: `codex-harness-adapter ${context.version}`,
      sourceRun: context.runId,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      releaseUrl: release.html_url,
    }
    mkdirSync(env.PROMOTE_OUTPUT, { recursive: true })
    writeJson(join(env.PROMOTE_OUTPUT, 'tap-inputs.json'), tap)
    writeJson(join(env.PROMOTE_OUTPUT, 'promotion.json'), {
      ...context,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      releaseId: release.id,
      mode: env.PROMOTE_MODE,
      assets: expected,
    })
    // 临公开再次检查，所有晋级工作流共用全局串行组，Latest 不能倒退。
    sourceRun(api(runPath), context)
    await verifyCandidate(dir, context, policyHash())
    await releasePolicy(policyContext)
    const finalRelease = api(`${base}/releases/${release.id}`)
    checkDraft(finalRelease, env.TAG, marker)
    assert.equal(finalRelease.body, body, '回验后发布说明被修改，禁止公开')
    const finalAssets = pages(assetPath)
    checkAssets(finalAssets, expected)
    assert.deepEqual(
      finalAssets.map((asset) => asset.id).sort(),
      assets.map((asset) => asset.id).sort(),
      '回验后资产被替换，禁止公开',
    )
    if (env.PROMOTE_MODE === 'publish') {
      gh(['api', `${base}/releases/${release.id}`, '--method', 'PATCH', '--input', '-'], {
        input: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }),
      })
    }
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `\n${env.PROMOTE_MODE === 'publish' ? '已按显式人工授权公开' : '草稿完成，未公开'}：${release.html_url}\n\nTap PR 输入已生成，未自动修改 tap。\n`,
      )
    return { mode: env.PROMOTE_MODE, sha: context.sha, artifact: artifact.id, release: release.id }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await promote()
