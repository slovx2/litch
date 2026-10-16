// 模拟核心的差异面板。这里模拟的是“对面”：照协议回答 process/spawn（跑的是假的 git，mock-git.mts）、
// process/kill、fs/watch、fs/unwatch、fs/getMetadata；这些之上的事——认仓库、合成概况、什么时候重新取、
// 暂存和还原之前的核对、看不了 git 时用本回合差异——用的就是真的核心那一份（device/diffs.mts）。
// 示例仓库在 sample-repos.mts。nas 这台示例设备起不了进程（差异看不了），给界面试降级用。
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import {
  type AbortSignalLike,
  ChannelError,
  type Clock,
  type Commands,
  type Topic,
} from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import { createDiffs, type Diffs } from '../device/diffs.mjs'
import { channelFailure } from '../device/faults.mjs'
import type { DeviceView, FileChangeEntry } from '../model.mjs'
import { capDiff } from '../text/diff.mjs'
import { insideRoot, normalizePath } from '../text/paths.mjs'
import { type FakeBlob, type FakeRepo, fakeGit, fakeGitWrites, fakePatch } from './mock-git.mjs'
import { SAMPLE_HOME, sampleRepos } from './sample-repos.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockDiffsHost {
  clock: Clock
  /** 对面“过一会儿才回”跟着它走，0 就是立刻 */
  stepMs: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
  /** 这个目录是不是这台设备上认得的根：某个工作区的根，或者某个会话的工作目录 */
  knownRoot(deviceId: string, root: string): boolean
  /** 这个会话所属的 harness 声明了发不发本回合差异。没声明、认不出是 null */
  turnDiffDeclared(deviceId: string, sessionId: string): boolean | null
}

export interface MockDiffs {
  /** 是差异面板的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown, signal: AbortSignalLike): Promise<unknown> | undefined
  subscribe(topic: Extract<Topic, { kind: 'diff' }>, sink: HostSink): () => void
  /** 一个回合结束了 */
  turnEnded(deviceId: string, sessionId: string): void
  /**
   * 演一出“代理改了文件”：在这个会话的工作目录里改一个文件、新加一个文件；big 为真时再新写一个几百行的。
   * 返回对话里那条“改了文件”要显示的内容。差异面板要等回合结束才跟着变（和真的一样）
   */
  agentEdit(
    deviceId: string,
    cwd: string,
    sessionId: string,
    turnId: string,
    big?: boolean,
  ): FileChangeEntry[]
}

/** “改大文件”新写的那个文件有多少行：比对话里一处差异肯展开的行数（四百）多 */
const BIG_LINES = 600
/** 这台示例设备上起不了进程 */
const NO_SPAWN = 'nas'
const METHOD_NOT_FOUND = -32601

const expand = (path: string): string =>
  path === '~' ? SAMPLE_HOME : path.startsWith('~/') ? SAMPLE_HOME + path.slice(1) : path
const shrink = (path: string): string =>
  path === SAMPLE_HOME
    ? '~'
    : path.startsWith(`${SAMPLE_HOME}/`)
      ? `~${path.slice(SAMPLE_HOME.length)}`
      : path

interface Remote {
  diffs: Diffs
  /** 仓库顶层 → 仓库。造过的留着：暂存、还原、代理的改动都记在它上面 */
  repos: Map<string, FakeRepo>
  /** 登记过的监视：标识 → 盯着的路径 */
  watches: Map<string, string>
  /** 不是仓库的目录里，代理写过的文件：目录 → 路径 → 内容 */
  plain: Map<string, Map<string, FakeBlob>>
  edits: number
}

export function createMockDiffs(host: MockDiffsHost): MockDiffs {
  const { clock } = host
  const makers = sampleRepos(host.lang)
  const remotes = new Map<string, Remote>()
  const pace = host.stepMs <= 0 ? 0 : Math.min(host.stepMs, 40)

  /** 包着这个目录的仓库 */
  const repoAt = (deviceId: string, remote: Remote, cwd: string): FakeRepo | null => {
    for (const [top, make] of makers.get(deviceId) ?? []) {
      if (!insideRoot(top, cwd)) continue
      let repo = remote.repos.get(top)
      if (!repo) {
        repo = make()
        remote.repos.set(top, repo)
      }
      return repo
    }
    return null
  }

  /** 仓库的元数据目录变了（暂存区被改了）：盯着它的都报一声 */
  const touched = (remote: Remote, path: string) => {
    for (const [watchId, watched] of remote.watches) {
      if (watched !== path) continue
      clock.setTimer(() => {
        if (remote.watches.has(watchId)) {
          remote.diffs.notification('fs/changed', { watchId, changedPaths: [path] })
        }
      }, pace)
    }
  }

  /** 对面：照协议回答 */
  const answer = async (
    deviceId: string,
    remote: Remote,
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    if (method === 'process/spawn') {
      if (deviceId === NO_SPAWN) throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
      const spawn = params as ClientRequests['process/spawn']['params']
      const cwd = normalizePath(spawn.cwd ?? '/')
      const repo = repoAt(deviceId, remote, cwd)
      // 进程“跑一小会儿”再结束，输出攒到结束时一次给
      clock.setTimer(() => {
        const result = fakeGit(repo, cwd, spawn.command)
        const cap = spawn.outputBytesCap ?? 1_048_576
        const capped = result.stdout.length > cap
        remote.diffs.notification('process/exited', {
          processHandle: spawn.processHandle,
          exitCode: result.exitCode,
          stdout: capped ? result.stdout.slice(0, cap) : result.stdout,
          stderr: result.stderr,
          stdoutCapReached: capped,
          stderrCapReached: false,
        })
        if (repo && fakeGitWrites(spawn.command)) touched(remote, `${repo.top}/.git`)
      }, pace)
      return {}
    }
    if (method === 'process/kill') return {}
    if (method === 'fs/watch') {
      const { watchId, path } = params as ClientRequests['fs/watch']['params']
      remote.watches.set(watchId, path)
      return { path }
    }
    if (method === 'fs/unwatch') {
      remote.watches.delete((params as ClientRequests['fs/unwatch']['params']).watchId)
      return {}
    }
    if (method === 'fs/getMetadata') {
      return { isDirectory: true, isFile: false, isSymlink: false, createdAtMs: 0, modifiedAtMs: 0 }
    }
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }

  const remoteOf = (deviceId: string): Remote => {
    const known = remotes.get(deviceId)
    if (known) return known
    if (!host.device(deviceId)) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    const remote: Remote = {
      repos: new Map(),
      watches: new Map(),
      plain: new Map(),
      edits: 0,
      diffs: createDiffs({
        clock,
        online: () => host.device(deviceId)?.connection === 'online',
        platform: () => host.device(deviceId)?.os ?? null,
        // 示例数据里的根有的写成 ~ 开头：两种写法都认
        knownRoot: (root) =>
          host.knownRoot(deviceId, root) || host.knownRoot(deviceId, shrink(root)),
        turnDiffDeclared: (sessionId) => host.turnDiffDeclared(deviceId, sessionId),
        request: <M extends ClientRequestMethod>(
          method: M,
          params: ClientRequests[M]['params'],
          _options?: RpcRequestOptions,
        ) => answer(deviceId, remote, method, params) as Promise<ClientRequests[M]['result']>,
        fail: (error) => channelFailure(error),
        log() {},
      }),
    }
    remotes.set(deviceId, remote)
    return remote
  }

  const diffsOf = (deviceId: string): Diffs => remoteOf(deviceId).diffs

  const handlers: {
    [K in keyof Commands]?: (params: Commands[K]['params'], signal: AbortSignalLike) => unknown
  } = {
    'diff.files': ({ deviceId, root, scope, sessionId }, signal) =>
      diffsOf(deviceId).files(expand(root), scope, sessionId ?? null, signal),
    'diff.file': ({ deviceId, root, scope, sessionId, path, full }, signal) =>
      diffsOf(deviceId).file(expand(root), scope, sessionId ?? null, path, full === true, signal),
    async 'diff.refresh'({ deviceId, root }) {
      await diffsOf(deviceId).refresh(expand(root))
      return {}
    },
    async 'diff.stage'({ deviceId, root, paths }) {
      await diffsOf(deviceId).stage(expand(root), paths)
      return {}
    },
    async 'diff.unstage'({ deviceId, root, paths }) {
      await diffsOf(deviceId).unstage(expand(root), paths)
      return {}
    },
    async 'diff.discard'({ deviceId, root, scope, path, expect }) {
      await diffsOf(deviceId).discard(expand(root), scope, path, expect)
      return {}
    },
    'diff.requests': ({ deviceId }) => diffsOf(deviceId).requests(),
  }

  return {
    command(name, params, signal) {
      const handler = handlers[name as keyof Commands] as
        | ((params: unknown, signal: AbortSignalLike) => unknown)
        | undefined
      if (!handler) return undefined
      return (async () => handler(params, signal))()
    },

    subscribe(topic, sink) {
      return diffsOf(topic.deviceId).open(
        expand(topic.root),
        topic.scope,
        topic.sessionId ?? null,
        sink,
      )
    },

    turnEnded(deviceId, sessionId) {
      remotes.get(deviceId)?.diffs.turnEnded(sessionId)
    },

    agentEdit(deviceId, cwd, sessionId, turnId, big = false) {
      const remote = remoteOf(deviceId)
      const at = normalizePath(expand(cwd))
      const repo = repoAt(deviceId, remote, at)
      const zh = host.lang === 'zh-CN'
      const serial = ++remote.edits
      const notes = 'notes/agent-log.md'
      const fresh = `notes/agent-${serial}.md`
      // 仓库里写在它的工作区上（路径相对于仓库顶层，这里的示例会话都在顶层）；不是仓库就另记一份
      let tree = repo?.work
      if (!tree) {
        tree = remote.plain.get(at) ?? new Map<string, FakeBlob>()
        remote.plain.set(at, tree)
      }
      const before = tree.get(notes)
      const earlier = before && typeof before.data === 'string' ? before.data : ''
      const line = zh ? `- 第 ${serial} 次改动` : `- change ${serial}`
      const after: FakeBlob = {
        data: `${earlier || (zh ? '# 代理记录\n\n' : '# Agent log\n\n')}${line}\n`,
      }
      const added: FakeBlob = {
        data: zh
          ? `# 第 ${serial} 份草稿\n\n这是代理新写的文件。\n`
          : `# Draft ${serial}\n\nA file the agent just wrote.\n`,
      }
      tree.set(notes, after)
      tree.set(fresh, added)
      const patches = [fakePatch(before, after, notes), fakePatch(undefined, added, fresh)]
      const more: FileChangeEntry[] = []
      if (big) {
        const long = `notes/agent-big-${serial}.md`
        const blob: FakeBlob = {
          data: Array.from({ length: BIG_LINES }, (_, n) =>
            zh
              ? `第 ${n + 1} 行：代理写的长文件。`
              : `Line ${n + 1} of a long file the agent wrote.`,
          )
            .join('\n')
            .concat('\n'),
        }
        tree.set(long, blob)
        const patch = fakePatch(undefined, blob, long)
        patches.push(patch)
        more.push({
          path: long,
          change: 'add',
          movedTo: null,
          added: patch.added,
          removed: 0,
          // 和真的对面来的一样按上限截（text/diff.mts）
          ...capDiff(patch.text, 'patch'),
          diffKind: 'patch',
        })
      }
      if (!repo && host.turnDiffDeclared(deviceId, sessionId) !== false) {
        remote.diffs.turnDiff(sessionId, turnId, patches.map((patch) => patch.text).join(''))
      }
      return [
        {
          path: notes,
          change: before ? 'update' : 'add',
          movedTo: null,
          added: patches[0]?.added ?? 0,
          removed: patches[0]?.removed ?? 0,
          diff: patches[0]?.text ?? '',
          diffKind: 'patch',
          elided: null,
        },
        {
          path: fresh,
          change: 'add',
          movedTo: null,
          added: patches[1]?.added ?? 0,
          removed: 0,
          diff: patches[1]?.text ?? '',
          diffKind: 'patch',
          elided: null,
        },
        ...more,
      ]
    },
  }
}
