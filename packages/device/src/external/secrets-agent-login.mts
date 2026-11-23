import { randomBytes } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { delimiter, isAbsolute, join } from 'node:path'
import { adapterCliPath } from '../../../shared/src/adapter-cli.mjs'
import type { ExternalStore } from '../external-store.mjs'
import { GithubWriteFault, login, numericId, object, repoName } from './github/write-api.mjs'
import { activeManager, type ExternalToolActor } from './outbox-read.mjs'
import type { ExternalGithubSecrets, GithubCredentialSnapshot } from './secrets.mjs'
import { agentHelperProgram, shellQuoteGithubHelper } from './secrets-agent-helper.mjs'
import { ExternalPrivateFiles } from './secrets-files.mjs'

type WorklineActor = Omit<Extract<ExternalToolActor, { kind: 'workline' }>, 'issueId'> & {
  issueId?: Extract<ExternalToolActor, { kind: 'workline' }>['issueId']
}
export type GithubAgentActor = Extract<ExternalToolActor, { kind: 'manager' }> | WorklineActor
export interface GithubManagerAssignment {
  identityId: string | null
  repoIds: readonly string[]
  injectCredentials?: boolean
}
interface GithubAgentOptions {
  store: ExternalStore
  secrets: ExternalGithubSecrets
  /** 只读设备上已提交的经理分配；缺省开启注入。 */
  assignmentForManager: (managerId: string) => GithubManagerAssignment | null
}
export interface GithubAgentResolution {
  state: 'host' | 'active'
  identityId: string | null
  repoIds: string[]
}

export function resolveGithubAgentLogin(
  options: GithubAgentOptions,
  managerId: string,
): GithubAgentResolution {
  const { store, secrets } = options
  const binding = options.assignmentForManager(managerId)
  const identityId = binding?.identityId ?? null
  const host: GithubAgentResolution = { state: 'host', identityId, repoIds: [] }
  if (
    !binding ||
    !identityId ||
    binding.injectCredentials === false ||
    store.manager.manager(managerId)?.status !== 'active'
  )
    return host
  const enabled = new Set(
    store.config
      .sources()
      .filter((source) => source.enabled)
      .flatMap((source) => source.repos.map((repo) => repo.repoId)),
  )
  const repoIds = [...new Set(binding.repoIds)].filter((id) => {
    if (!enabled.has(id)) return false
    try {
      secrets.activeForRepository(id, identityId)
      return true
    } catch {
      return false
    }
  })
  return repoIds.length ? { state: 'active', identityId, repoIds } : host
}

interface LaunchConfig {
  files: ExternalPrivateFiles
  version: string
}
interface Launch {
  actor: GithubAgentActor
  files: ExternalPrivateFiles
  configs: Map<string, LaunchConfig>
}
interface ServiceOptions extends GithubAgentOptions {
  stateDirectory: string
  /** 设备私有 Unix socket 或 Windows named pipe。不能监听 TCP。 */
  callbackPath: string
  ghPath: string
  prepareGh?: () => Promise<string>
  hostGhPath?: string
  gitPath: string
  nodePath?: string
  isWorklineCurrent: (actor: WorklineActor) => boolean
}

export class GithubAgentLoginService {
  private readonly options: ServiceOptions
  private readonly root: ExternalPrivateFiles
  private readonly credentialSlots: string
  private readonly adapter: string
  private readonly launches = new Map<string, Launch>()
  private readonly sockets = new Set<Socket>()
  private readonly server: Server
  private readonly unsubscribe: () => void

  private constructor(options: ServiceOptions) {
    this.options = options
    this.root = new ExternalPrivateFiles(join(options.stateDirectory, 'external-agent-gh'))
    this.credentialSlots = new ExternalPrivateFiles(
      join(this.root.directory, 'credential-slots'),
    ).directory
    this.adapter = adapterCliPath()
    if (!this.adapter) throw new Error('external_agent_command_missing')
    // 设备状态锁已由 H 持有；重启后旧句柄无法再用。
    for (const key of this.root.keys()) {
      if (/^launch-[a-f\d]{64}$/.test(key))
        rmSync(this.root.path(key), { recursive: true, force: true })
    }
    this.server = createServer((socket) => this.serve(socket))
    this.unsubscribe = options.secrets.onChanged(() => this.refresh())
  }

  static async start(options: ServiceOptions): Promise<GithubAgentLoginService> {
    const node = options.nodePath ?? process.execPath
    if (
      ![
        node,
        options.ghPath,
        options.gitPath,
        ...(options.hostGhPath ? [options.hostGhPath] : []),
      ].every((path) => isAbsolute(path) && !/["\r\n\0]/.test(path)) ||
      !(process.platform === 'win32'
        ? /^\\\\\.\\pipe\\[a-z\d._-]+$/i.test(options.callbackPath)
        : isAbsolute(options.callbackPath))
    )
      throw new Error('external_agent_github_paths_invalid')
    const service = new GithubAgentLoginService(options)
    try {
      await new Promise<void>((resolve, reject) => {
        service.server.once('error', reject)
        service.server.listen(options.callbackPath, resolve)
      })
      if (process.platform !== 'win32') chmodSync(options.callbackPath, 0o600)
      return service
    } catch {
      await service.close()
      throw new Error('external_agent_github_callback_unavailable')
    }
  }

  resolve(managerId: string): GithubAgentResolution {
    return resolveGithubAgentLogin(this.options, managerId)
  }

  /** 始终从宿主原始环境组装；结束会话/回合后由 H 调用 dispose。 */
  environment(
    actor: GithubAgentActor,
    env: NodeJS.ProcessEnv,
  ): {
    env: NodeJS.ProcessEnv
    resolution: GithubAgentResolution
    ghPath?: string
    ghArgs?: string[]
    dispose(): void
  } {
    if (!this.authorized(actor))
      return { env, resolution: { state: 'host', identityId: null, repoIds: [] }, dispose() {} }
    const resolution = this.resolve(actor.managerId)
    const raw = env.GIT_CONFIG_COUNT ?? '0'
    if (resolution.state !== 'active' || !/^\d{1,3}$/.test(raw) || Number(raw) > 100)
      return { env, resolution, dispose() {} }
    const key = randomBytes(32).toString('hex')
    const files = new ExternalPrivateFiles(this.root.path(`launch-${key}`))
    const launch: Launch = { actor, files, configs: new Map() }
    const node = this.options.nodePath ?? process.execPath
    const shell = shellQuoteGithubHelper
    try {
      files.write('helper.cjs', agentHelperProgram)
      const args = [
        node,
        files.path('helper.cjs'),
        this.options.callbackPath,
        key,
        this.options.ghPath,
        this.options.gitPath,
        this.options.hostGhPath ?? (this.options.prepareGh ? '' : this.options.ghPath),
      ]
      const cmd = args.map(shell).join(' ')
      const credential = [this.adapter, 'agent-credential', this.credentialSlots, ...args, 'git']
        .map(shell)
        .join(' ')
      const isWindows = process.platform === 'win32'
      const shimName = isWindows ? 'gh.cmd' : 'gh'
      const shim = files.path(shimName)
      const cmdArg = (value: string) => `"${value.replaceAll('%', '%%')}"`
      files.write(
        shimName,
        isWindows
          ? `@echo off\r\n${args.map(cmdArg).join(' ')} gh %*\r\n`
          : `#!/bin/sh\nexec ${cmd} gh "$@"\n`,
      )
      if (!isWindows) chmodSync(shim, 0o700)
      const cfg = Number(raw)
      const pathKey = isWindows
        ? (Object.keys(env).find((name) => /^path$/i.test(name)) ?? 'Path')
        : 'PATH'
      this.launches.set(key, launch)
      return {
        resolution,
        ghPath: shim,
        ...(isWindows ? { ghArgs: [...args.slice(1), 'gh'] } : {}),
        env: {
          ...env,
          [pathKey]: `${files.directory}${env[pathKey] ? delimiter + env[pathKey] : ''}`,
          LITCH_GITHUB_HELPER_CONFIG_INDEX: String(cfg),
          GIT_CONFIG_COUNT: String(cfg + 3),
          [`GIT_CONFIG_KEY_${cfg}`]: 'credential.https://github.com.helper',
          [`GIT_CONFIG_VALUE_${cfg}`]: '',
          [`GIT_CONFIG_KEY_${cfg + 1}`]: 'credential.https://github.com.helper',
          [`GIT_CONFIG_VALUE_${cfg + 1}`]: `!${credential}`,
          [`GIT_CONFIG_KEY_${cfg + 2}`]: 'credential.https://github.com.useHttpPath',
          [`GIT_CONFIG_VALUE_${cfg + 2}`]: 'true',
        },
        dispose: () => {
          this.launches.delete(key)
          rmSync(files.directory, { recursive: true, force: true })
        },
      }
    } catch {
      rmSync(files.directory, { recursive: true, force: true })
      throw new Error('external_agent_github_setup_failed')
    }
  }

  /** H 在来源/路由/经理选择/owner 变更后同步调用。每次 gh/git 查询也重新验证。 */
  refresh(): void {
    for (const launch of this.launches.values()) {
      const live = this.credentials(launch)
      for (const [owner, config] of launch.configs) {
        const fresh = live.find((entry) => entry.metadata.credentialRef === owner)
        try {
          if (fresh) this.syncGh(launch, fresh)
          else {
            config.files.remove('hosts.yml')
            launch.configs.delete(owner)
          }
        } catch {
          try {
            config.files.remove('hosts.yml')
          } catch {
            /* 回调仍判断当前授权。 */
          }
          launch.configs.delete(owner)
        }
      }
    }
  }

  async close(): Promise<void> {
    this.unsubscribe()
    for (const socket of this.sockets) socket.destroy()
    for (const launch of this.launches.values())
      rmSync(launch.files.directory, { recursive: true, force: true })
    this.launches.clear()
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private authorized(actor: GithubAgentActor): boolean {
    return (
      activeManager(this.options.store, actor) &&
      (actor.kind === 'manager' || this.options.isWorklineCurrent(actor))
    )
  }

  private credentials(launch: Launch): GithubCredentialSnapshot[] {
    if (!this.authorized(launch.actor)) return []
    const resolved = this.resolve(launch.actor.managerId)
    if (!resolved.identityId) return []
    return resolved.repoIds.flatMap((repoId) => {
      try {
        return [this.options.secrets.activeForRepository(repoId, resolved.identityId ?? undefined)]
      } catch {
        return []
      }
    })
  }

  private credentialFor(launch: Launch, repository: unknown): GithubCredentialSnapshot | undefined {
    if (typeof repository !== 'string') return undefined
    const [owner, name, extra] = repository.split('/')
    if (!login(owner) || !repoName(name) || extra !== undefined) return undefined
    const resolved = this.resolve(launch.actor.managerId)
    if (!this.authorized(launch.actor) || !resolved.identityId) return undefined
    for (const repoId of resolved.repoIds) {
      try {
        const entry = this.options.secrets.activeForRepository(repoId, resolved.identityId)
        if (
          entry.repos.some(
            (repo) =>
              repo.repoId === repoId &&
              repo.owner.toLowerCase() === owner.toLowerCase() &&
              repo.name.toLowerCase() === name.toLowerCase(),
          )
        )
          return entry
      } catch {
        /* 代次或分配已经变更。 */
      }
    }
    return undefined
  }

  private syncGh(launch: Launch, credential: GithubCredentialSnapshot): string {
    const ownerId = numericId(credential.metadata.resourceOwnerId)
    if (!ownerId) throw new Error('external_agent_github_scope_invalid')
    const ref = credential.metadata.credentialRef
    const cached = launch.configs.get(ref)
    const directory =
      credential.metadata.credentialKind === 'oauth' ? `oauth-${ref}` : `owner-${ownerId}`
    const files = cached?.files ?? new ExternalPrivateFiles(launch.files.path(directory))
    const version = `${credential.metadata.credentialRef}/${credential.metadata.generation}`
    if (cached?.version !== version) {
      const { botLogin, token } = credential
      files.write(
        'hosts.yml',
        [
          'github.com:',
          `    user: ${botLogin}`,
          `    oauth_token: ${token}`,
          '    git_protocol: https',
          '    users:',
          `        ${botLogin}:`,
          `            oauth_token: ${token}`,
          '',
        ].join('\n'),
      )
      launch.configs.set(ref, { files, version })
    }
    return files.directory
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
    socket.setTimeout(2500, () => socket.destroy())
    let raw = ''
    socket.setEncoding('utf8')
    const data = (part: string) => {
      raw += part
      if (raw.length > 1024) {
        socket.destroy()
        return
      }
      if (!raw.endsWith('\n')) return
      socket.off('data', data)
      try {
        const request = object(JSON.parse(raw))
        const launch = typeof request.key === 'string' ? this.launches.get(request.key) : undefined
        const isGit =
          request.mode === 'git' && request.host === 'github.com' && request.protocol === 'https'
        const isGh = request.mode === 'gh'
        const credential =
          launch && (isGit || isGh) ? this.credentialFor(launch, request.repository) : undefined
        if (credential && isGit) socket.end(JSON.stringify({ token: credential.token }))
        else if (credential && launch && isGh) {
          socket.setTimeout(115_000)
          void this.ghConfig(socket, launch, request.key, request.repository, credential)
        } else socket.end('{}')
      } catch {
        socket.destroy()
      }
    }
    socket.on('data', data)
  }

  private async ghConfig(
    socket: Socket,
    launch: Launch,
    key: unknown,
    repository: unknown,
    initial: GithubCredentialSnapshot,
  ) {
    try {
      // 仅对获准使用受管 gh 的仓库下载；Git 凭据回调和非分派仓库不需要它。
      if (this.options.prepareGh) await this.options.prepareGh()
      if (socket.destroyed) return
      const credential =
        typeof key === 'string' && this.launches.get(key) === launch
          ? this.credentialFor(launch, repository)
          : undefined
      if (
        !credential ||
        credential.metadata.credentialRef !== initial.metadata.credentialRef ||
        credential.metadata.generation !== initial.metadata.generation
      ) {
        socket.end(JSON.stringify({ error: 'github_gh_scope_changed' }))
        return
      }
      socket.end(JSON.stringify({ config: this.syncGh(launch, credential) }))
    } catch (error) {
      if (!socket.destroyed)
        socket.end(
          JSON.stringify({
            error: error instanceof GithubWriteFault ? error.code : 'github_gh_unavailable',
          }),
        )
    }
  }
}
