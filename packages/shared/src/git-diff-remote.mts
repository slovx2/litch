import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commandEnv } from './command-env.mjs'

// 移植 Codex 0.157.1 codex-rs/git-utils/src/info.rs 的 git_diff_to_remote：
// 以最近的、同时存在于远端的提交为基准，返回与它的 diff（含未跟踪文件）。
const GIT_COMMAND_TIMEOUT_MS = 5_000
const GIT_CONFIG = [
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
]

interface GitOutput {
  status: number | null
  stdout: Buffer
}

// 进程级失败或超时返回 null，对应原生 run_git_command_with_timeout 的 None。
function runGit(args: string[], cwd: string): Promise<GitOutput | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', [...GIT_CONFIG, ...args], {
        cwd,
        env: { ...commandEnv(undefined), GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      })
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    const settle = (value: GitOutput | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
      settle(null)
    }, GIT_COMMAND_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', () => settle(null))
    child.once('close', (status) => settle({ status, stdout: Buffer.concat(chunks) }))
  })
}

function utf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function successText(output: GitOutput | null): string | null {
  return output?.status === 0 ? utf8(output.stdout) : null
}

function repoRoot(cwd: string): string | null {
  let directory: string
  try {
    directory = statSync(cwd).isDirectory() ? cwd : dirname(cwd)
  } catch {
    directory = dirname(cwd)
  }
  for (;;) {
    const dotGit = join(directory, '.git')
    if (existsSync(dotGit)) {
      try {
        if (!statSync(dotGit).isDirectory() || existsSync(join(dotGit, 'HEAD'))) return directory
      } catch {}
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

async function gitRemotes(cwd: string): Promise<string[] | null> {
  const text = successText(await runGit(['remote'], cwd))
  if (text == null) return null
  // 与 Rust str::lines 一致：末尾换行不产生空行，行尾 \r 去掉。
  const remotes = text.split('\n').map((line) => line.replace(/\r$/, ''))
  if (remotes.at(-1) === '') remotes.pop()
  const origin = remotes.indexOf('origin')
  if (origin > 0) remotes.unshift(...remotes.splice(origin, 1))
  return remotes
}

async function defaultBranch(cwd: string): Promise<string | null> {
  for (const remote of (await gitRemotes(cwd)) ?? []) {
    const symbolic = successText(
      await runGit(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], cwd),
    )
    const slash = symbolic?.trim().lastIndexOf('/') ?? -1
    if (symbolic != null && slash >= 0) return symbolic.trim().slice(slash + 1)
    const show = successText(await runGit(['remote', 'show', remote], cwd))
    for (const line of show?.split('\n') ?? []) {
      const trimmed = line.trim()
      if (trimmed.startsWith('HEAD branch:')) {
        const name = trimmed.slice('HEAD branch:'.length).trim()
        if (name) return name
      }
    }
  }
  for (const candidate of ['main', 'master'])
    if (
      (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd))
        ?.status === 0
    )
      return candidate
  return null
}

async function branchAncestry(cwd: string): Promise<string[]> {
  const current = successText(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim()
  const fallback = await defaultBranch(cwd)
  const ancestry: string[] = []
  const seen = new Set<string>()
  const add = (branch: string | null | undefined) => {
    if (branch == null || seen.has(branch)) return
    seen.add(branch)
    ancestry.push(branch)
  }
  if (current != null && current !== 'HEAD') add(current)
  add(fallback)
  // 本地新分支可能从非默认的远端分支分出：追加所有已包含 HEAD 的远端分支。
  for (const remote of (await gitRemotes(cwd)) ?? []) {
    const text = successText(
      await runGit(
        ['for-each-ref', '--format=%(refname:short)', '--contains=HEAD', `refs/remotes/${remote}`],
        cwd,
      ),
    )
    for (const line of text?.split('\n') ?? []) {
      const short = line.trim()
      if (!short.startsWith(`${remote}/`)) continue
      const branch = short.slice(remote.length + 1)
      if (branch) add(branch)
    }
  }
  return ancestry
}

async function branchRemoteAndDistance(
  cwd: string,
  branch: string,
  remotes: string[],
): Promise<{ sha: string | null; distance: number } | null> {
  let sha: string | null = null
  let remoteRef: string | null = null
  for (const remote of remotes) {
    const ref = `refs/remotes/${remote}/${branch}`
    const verify = await runGit(['rev-parse', '--verify', '--quiet', ref], cwd)
    if (!verify) return null
    if (verify.status !== 0) continue
    const text = utf8(verify.stdout)
    if (text == null) return null
    sha = text.trim()
    remoteRef = ref
    break
  }
  let count = await runGit(['rev-list', '--count', `${branch}..HEAD`], cwd)
  if (count?.status !== 0) {
    if (!remoteRef) return null
    count = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], cwd)
  }
  if (count?.status !== 0) return null
  const text = utf8(count.stdout)?.trim()
  if (!text || !/^\d+$/.test(text)) return null
  return { sha, distance: Number(text) }
}

async function closestSha(
  cwd: string,
  branches: string[],
  remotes: string[],
): Promise<string | null> {
  let closest: { sha: string; distance: number } | null = null
  for (const branch of branches) {
    const found = await branchRemoteAndDistance(cwd, branch, remotes)
    if (!found?.sha) continue
    if (!closest || found.distance < closest.distance)
      closest = { sha: found.sha, distance: found.distance }
  }
  return closest?.sha ?? null
}

async function diffAgainstSha(cwd: string, sha: string): Promise<string | null> {
  const output = await runGit(['diff', '--no-textconv', '--no-ext-diff', sha], cwd)
  // 0 表示无差异，1 表示有差异。
  if (!output || (output.status !== 0 && output.status !== 1)) return null
  let diff = utf8(output.stdout)
  if (diff == null) return null
  const untracked = await runGit(['ls-files', '--others', '--exclude-standard'], cwd)
  if (untracked?.status === 0) {
    const listing = utf8(untracked.stdout)
    if (listing == null) return null
    const files = listing.split('\n').filter(Boolean)
    const extras = await Promise.all(
      files.map((file) =>
        runGit(
          [
            'diff',
            '--no-textconv',
            '--no-ext-diff',
            '--binary',
            '--no-index',
            '--',
            '/dev/null',
            file,
          ],
          cwd,
        ),
      ),
    )
    for (const extra of extras) {
      if (!extra || (extra.status !== 0 && extra.status !== 1)) continue
      const text = utf8(extra.stdout)
      if (text != null) diff += text
    }
  }
  return diff
}

export async function gitDiffToRemote(cwd: string): Promise<{ sha: string; diff: string } | null> {
  if (!repoRoot(cwd)) return null
  const remotes = await gitRemotes(cwd)
  if (!remotes) return null
  const sha = await closestSha(cwd, await branchAncestry(cwd), remotes)
  if (!sha) return null
  const diff = await diffAgainstSha(cwd, sha)
  return diff == null ? null : { sha, diff }
}
