import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { fuzzyPathMatch } from './fuzzy-search.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog } from './util.mjs'

// 移植 Codex 0.157.1 app-server/src/fuzzy_file_search.rs 与 request_processors/search.rs。
const MATCH_LIMIT = 50

interface IndexedEntry {
  root: string
  path: string
  matchType: 'file' | 'directory'
}

export interface FuzzyFileMatch {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
  score: number
  indices: number[]
}

// 与原生 ignore 遍历一致：包含隐藏条目、跟随符号链接、仅在 git 仓库内应用 gitignore。
// rg 只列文件，目录由文件路径推导（原生还会列出空目录，此处不包含）。
// 原生遍历对单个条目出错只跳过；rg/find 遇到不可读目录或符号链接循环会以非零状态结束，
// 因此只要命令成功启动就采用其输出，命令不存在时才换下一个。
function listing(command: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(Buffer.concat(chunks).toString('utf8'))
    }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', (error) => {
      debugLog('fuzzySearch.listFailed', { command, cwd, error: String(error) })
      finish(null)
    })
    child.once('close', () => finish(Buffer.concat(chunks).toString('utf8')))
  })
}

async function listEntries(root: string): Promise<IndexedEntry[]> {
  const rg = await listing('rg', ['--files', '--hidden', '--follow'], root)
  const found = rg ?? (await listing('find', ['-L', '.', '-type', 'f'], root))
  if (found == null) return []
  const files = found
    .split('\n')
    .filter(Boolean)
    .map((path) => (rg == null ? path.replace(/^\.\//, '') : path))
  const directories = new Set<string>()
  for (const file of files)
    for (
      let directory = dirname(file);
      directory !== '.' && directory !== '/';
      directory = dirname(directory)
    ) {
      if (directories.has(directory)) break
      directories.add(directory)
    }
  return [
    ...files.map((path) => ({ root, path, matchType: 'file' as const })),
    ...[...directories].map((path) => ({ root, path, matchType: 'directory' as const })),
  ]
}

function indexRoots(roots: string[]): Promise<IndexedEntry[]> {
  return Promise.all(roots.map(listEntries)).then((lists) => lists.flat())
}

function match(query: string, entries: IndexedEntry[]): FuzzyFileMatch[] {
  const files: FuzzyFileMatch[] = []
  for (const entry of entries) {
    const found = fuzzyPathMatch(query, entry.path)
    if (!found) continue
    files.push({
      root: entry.root,
      path: entry.path,
      match_type: entry.matchType,
      file_name: basename(entry.path),
      ...found,
    })
  }
  // 与原生 cmp_by_score_desc_then_path_asc 一致。
  return files
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MATCH_LIMIT)
}

// 一次性搜索：空查询直接返回空结果；同一 cancellationToken 的新请求会取消旧请求。
export class FuzzyFileSearch {
  private readonly pending = new Map<string, { cancelled: boolean }>()

  async search(params: Record<string, unknown>): Promise<{ files: FuzzyFileMatch[] }> {
    const query = typeof params.query === 'string' ? params.query : ''
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : []
    const token = typeof params.cancellationToken === 'string' ? params.cancellationToken : null
    const flag = { cancelled: false }
    if (token) {
      const existing = this.pending.get(token)
      if (existing) existing.cancelled = true
      this.pending.set(token, flag)
    }
    try {
      if (!query || !roots.length) return { files: [] }
      const files = match(query, await indexRoots(roots))
      return { files: flag.cancelled ? [] : files }
    } finally {
      if (token && this.pending.get(token) === flag) this.pending.delete(token)
    }
  }
}

interface SearchSession {
  entries: Promise<IndexedEntry[]>
  latestQuery: string
  generation: number
  cancelled: boolean
  peer: RpcPeer
}

type Notify = (peer: RpcPeer, message: { method: string; params: unknown }) => void

// 会话只遍历一次建立索引；更新立即返回，结果仍是最新查询时先发 sessionUpdated 再发
// sessionCompleted。原生按会话广播到所有连接，此处发给最近一次启动或更新会话的连接。
export class FuzzySearchSessions {
  private readonly sessions = new Map<string, SearchSession>()
  private readonly notify: Notify

  constructor(notify: Notify) {
    this.notify = notify
  }

  start(peer: RpcPeer, params: Record<string, unknown>): Record<string, never> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) throw new ProtocolError(-32600, 'sessionId must not be empty')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : []
    if (!roots.length)
      throw new ProtocolError(
        -32603,
        'failed to start fuzzy file search session: at least one search directory is required',
      )
    const previous = this.sessions.get(sessionId)
    if (previous) previous.cancelled = true
    const session: SearchSession = {
      entries: indexRoots(roots),
      latestQuery: '',
      generation: 0,
      cancelled: false,
      peer,
    }
    this.sessions.set(sessionId, session)
    // 初始遍历完成时若查询仍为空，原生会报告一次空快照并完成。
    setImmediate(() => void this.report(sessionId, session, 0))
    return {}
  }

  update(peer: RpcPeer, params: Record<string, unknown>): Record<string, never> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessions.get(sessionId)
    if (!session)
      throw new ProtocolError(-32600, `fuzzy file search session not found: ${sessionId}`)
    session.peer = peer
    session.latestQuery = typeof params.query === 'string' ? params.query : ''
    session.generation += 1
    // 延后到响应写出之后，保证客户端先收到 {} 再收到通知（与原生一致）。
    const generation = session.generation
    setImmediate(() => void this.report(sessionId, session, generation))
    return {}
  }

  stop(params: Record<string, unknown>): Record<string, never> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessions.get(sessionId)
    if (session) session.cancelled = true
    this.sessions.delete(sessionId)
    return {}
  }

  private async report(
    sessionId: string,
    session: SearchSession,
    generation: number,
  ): Promise<void> {
    let entries: IndexedEntry[]
    try {
      entries = await session.entries
    } catch {
      entries = []
    }
    if (session.cancelled || generation !== session.generation) return
    const query = session.latestQuery
    const files = query ? match(query, entries) : []
    if (session.cancelled || generation !== session.generation) return
    this.notify(session.peer, {
      method: 'fuzzyFileSearch/sessionUpdated',
      params: { sessionId, query, files },
    })
    this.notify(session.peer, { method: 'fuzzyFileSearch/sessionCompleted', params: { sessionId } })
  }
}
