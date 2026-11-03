// 第一笔只读入口：全部GitHub调用显式GET；不含重跑、issue写入或工作流触发。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { observation } from './recovery-audit.mjs'
import { readStepLog } from './recovery-evidence.mjs'
import { classifyJob, evidenceHash, planRecovery } from './recovery-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repository = 'slovx2/litch'

export function githubReader(execute = execFileSync) {
  const deadline = Date.now() + 8 * 60_000
  const immutable = new Map()
  return (path, bytes = false) => {
    assert.ok(Date.now() < deadline, '只读观察总时间超过8分钟')
    // 仓库元信息用精确根路径；子资源仍须有斜线边界，不能放行同名前缀仓库。
    assert.ok(
      path === `repos/${repository}` || path.startsWith(`repos/${repository}/`),
      '只读本仓库相对API路径',
    )
    // compare端点的三个点是GitHub语法，不是目录穿越；只允许两个完整SHA。
    const compare = /^repos\/slovx2\/litch\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(path)
    assert.ok((!path.includes('..') || compare) && !/[\r\n]/.test(path), 'API路径')
    const cacheable = !bytes && (compare || /\/contents\/[^?]+\?ref=[a-f0-9]{40}$/.test(path))
    if (cacheable && immutable.has(path)) return structuredClone(immutable.get(path))
    let output
    try {
      output = execute('gh', ['api', '--method', 'GET', '--allow-escape-sequences', path], {
        encoding: bytes ? null : 'utf8',
        timeout: Math.min(30_000, deadline - Date.now()),
        maxBuffer: bytes ? 64 * 1024 * 1024 : 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      throw new Error('GitHub只读请求失败或超过边界；原输出不写入审计')
    }
    const value = bytes ? output : JSON.parse(output)
    if (cacheable) immutable.set(path, structuredClone(value))
    return value
  }
}

export function readPages(read, path, key) {
  const values = []
  for (let page = 1; page <= 20; page++) {
    const response = read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const items = key ? response[key] : response
    assert.ok(Array.isArray(items), '分页响应')
    values.push(...items)
    if (items.length < 100) return values
  }
  throw new Error('分页超出上限，不以截断数据判定可恢复')
}

export function localWorkflowContract() {
  return Object.fromEntries(
    readdirSync(join(root, '.github/workflows'))
      .filter((file) => file.endsWith('.yml'))
      .sort()
      .map((file) => {
        const path = `.github/workflows/${file}`
        return [path, evidenceHash(readFileSync(join(root, path), 'utf8'))]
      }),
  )
}

export function bindSource(read, run, expectedFiles, rehearsalSource) {
  assert.ok(Object.keys(expectedFiles).length > 0, '工作流契约不能为空')
  for (const [path, hash] of Object.entries(expectedFiles)) {
    assert.match(
      path,
      /^(?:\.github\/workflows\/[a-z0-9-]+\.yml|scripts\/ci\/[a-z0-9-]+\.mjs|package(?:-lock)?\.json)$/,
    )
    assert.match(hash, /^[a-f0-9]{64}$/)
  }
  const base = `repos/${repository}`
  const metadata = read(base)
  const branch = metadata.default_branch
  if (rehearsalSource) {
    assert.equal(rehearsalSource.ref, 'ci/recovery-nightly')
    assert.match(rehearsalSource.sha, /^[a-f0-9]{40}$/)
    assert.equal(run.path, '.github/workflows/recovery-fixture.yml')
    assert.equal(run.event, 'workflow_dispatch')
    assert.equal(run.head_branch, rehearsalSource.ref)
    assert.equal(run.head_sha, rehearsalSource.sha)
    assert.equal(run.head_repository?.full_name, repository)
    const hashes = {}
    for (const [path, expected] of Object.entries(expectedFiles)) {
      const file = read(`${base}/contents/${path}?ref=${run.head_sha}`)
      assert.equal(file.type, 'file')
      assert.equal(file.encoding, 'base64')
      hashes[path] = evidenceHash(Buffer.from(file.content, 'base64').toString('utf8'))
      assert.equal(hashes[path], expected, '演练源码与控制器不同')
    }
    return {
      matched: true,
      sha: run.head_sha,
      trustedSha: rehearsalSource.sha,
      digest: evidenceHash(hashes),
      rehearsal: true,
    }
  }
  const trustedSha = read(`${base}/commits/${encodeURIComponent(branch)}`).sha
  assert.match(trustedSha, /^[a-f0-9]{40}$/)
  const failed = (reason) => ({ matched: false, reason, sha: run.head_sha, trustedSha })
  if (run.head_branch !== branch || run.head_repository?.full_name !== repository)
    return failed('not-default-branch-source')
  const comparison = read(`${base}/compare/${run.head_sha}...${trustedSha}`)
  if (!['ahead', 'identical'].includes(comparison.status))
    return failed('not-default-branch-ancestor')
  const hashes = {}
  for (const [path, expected] of Object.entries(expectedFiles)) {
    // 源run和默认分支两边均比对本地受审查工作流；拒绝旧编排套用新分类。
    for (const sha of new Set([run.head_sha, trustedSha])) {
      const file = read(`${base}/contents/${path}?ref=${sha}`)
      if (file.type !== 'file' || file.encoding !== 'base64')
        return failed('workflow-content-missing')
      const digest = evidenceHash(Buffer.from(file.content, 'base64').toString('utf8'))
      if (digest !== expected) return failed(`workflow-content-differs:${path}`)
      hashes[`${sha}:${path}`] = digest
    }
  }
  return { matched: true, sha: run.head_sha, trustedSha, digest: evidenceHash(hashes) }
}

export function observeRun(
  runId,
  {
    read = githubReader(),
    contract = localWorkflowContract(),
    now = Date.now(),
    includeSnapshot = false,
    rehearsalSource,
  } = {},
) {
  assert.match(String(runId), /^[1-9][0-9]*$/)
  const base = `repos/${repository}`
  const path = `${base}/actions/runs/${runId}`
  const run = read(path)
  assert.equal(run.id, Number(runId))
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  const jobs = readPages(read, `${path}/attempts/${run.run_attempt}/jobs`, 'jobs')
  let sourceBinding
  try {
    sourceBinding = bindSource(read, run, contract, rehearsalSource)
  } catch {
    sourceBinding = { matched: false, reason: 'source-read-unavailable', sha: run.head_sha }
  }
  const evidence = {}
  let archive
  for (const job of jobs) {
    if (['success', 'skipped'].includes(job.conclusion) || job.status !== 'completed') continue
    let stage = 'check-run'
    try {
      const check = read(`${base}/check-runs/${job.id}`)
      assert.equal(check.id, job.id)
      assert.equal(check.head_sha, run.head_sha)
      assert.equal(check.app?.slug, 'github-actions')
      stage = 'check-annotations'
      const annotations = readPages(read, `${base}/check-runs/${job.id}/annotations`)
      evidence[job.id] = { annotations }
      const preliminary = classifyJob(job, evidence[job.id])
      if (
        preliminary.reason === 'exact-step-log-missing' ||
        (includeSnapshot && job.steps?.filter((item) => item.conclusion === 'failure').length === 1)
      ) {
        stage = 'log-archive'
        archive ??= read(`${path}/attempts/${run.run_attempt}/logs`, true)
        const step = job.steps.find((item) => item.conclusion === 'failure')
        stage = 'step-log'
        evidence[job.id].stepLog = readStepLog(archive, job, step)
      }
    } catch {
      // 读取/归档失败只留下固定原因；不把异常携带的原日志打印出来。
      evidence[job.id] = { unavailable: true, stage }
    }
  }
  const activeMac = []
  let activityComplete = true
  try {
    const seen = new Set()
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      for (const other of readPages(
        read,
        `${base}/actions/runs?status=${status}`,
        'workflow_runs',
      )) {
        if (other.id === run.id || seen.has(other.id)) continue
        seen.add(other.id)
        for (const job of readPages(read, `${base}/actions/runs/${other.id}/jobs`, 'jobs')) {
          if (
            job.status !== 'completed' &&
            job.labels?.some((label) => /^macos(?:-|$)/.test(label))
          )
            activeMac.push({ runId: other.id, jobId: job.id, status: job.status })
        }
      }
    }
  } catch {
    activityComplete = false
  }
  // 采样结束再读一次，避免把已开始人工重跑的旧attempt当可恢复。
  const latest = read(path)
  const unchanged =
    latest.head_sha === run.head_sha &&
    latest.run_attempt === run.run_attempt &&
    latest.status === run.status &&
    latest.conclusion === run.conclusion
  const snapshot = { run, jobs, evidence, sourceBinding, activeMac }
  const plan = planRecovery(snapshot, { now })
  if (!unchanged || !activityComplete) {
    plan.decision = 'blocked'
    plan.reason = unchanged ? 'mac-activity-read-incomplete' : 'source-changed-during-observation'
    plan.roots = []
  }
  return {
    plan,
    audit: observation(plan, now),
    ...(includeSnapshot ? { snapshot, stable: unchanged && activityComplete } : {}),
  }
}

export function recoverySummary({ plan }) {
  const lines = [
    '## 基础设施恢复只读观察',
    '自动恢复：未启用。没有预占预算、写issue或调用重跑API。',
    `源run：${plan.runId}；attempt：${plan.attempt}；SHA：${plan.sha}。`,
    `分类：${plan.decision} / ${plan.reason}。eligible仍须核实完整下游并写持久reservation。`,
    '| Job ID | 分类 | 原因 |',
    '|---|---|---|',
    ...plan.jobs.map((job) => `| ${job.id} | ${job.kind} | ${job.reason} |`),
  ]
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = observeRun(process.argv[2])
    console.log(JSON.stringify(result, null, 2))
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, recoverySummary(result))
  } catch {
    console.error('只读恢复观察失败，未执行恢复或任何GitHub写操作。')
    process.exitCode = 1
  }
}
