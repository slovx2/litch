import { randomBytes } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { delimiter, isAbsolute, join } from 'node:path'
import { adapterCliPath } from '../../../shared/src/adapter-cli.mjs'
import type { ExternalStore } from '../external-store.mjs'
import { GithubWriteFault, numericId, object } from './github/write-api.mjs'
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
/**
 * host：会话没有注入（无身份、注入关闭、经理不在运行），照旧用宿主 gh/Git。
 * active：注入且身份恰好有一份可用凭据。broken：注入了但不可用（凭据撤销、失效、身份不存在或
 * 有多份凭据），gh/Git 报出 reason，不回退宿主凭据。注入后不看运行目录和目标仓库。
 */
export type GithubAgentResolution =
  | { state: 'host'; identityId: string | null }
  | { state: 'active'; identityId: string; credentialRef: string }
  | { state: 'broken'; identityId: string; reason: GithubAgentBrokenReason }
export type GithubAgentBrokenReason =
  | 'github_identity_not_found'
  | 'github_agent_credential_unavailable'
  | 'github_agent_identity_ambiguous'

export function resolveGithubAgentLogin(
  options: GithubAgentOptions,
  managerId: string,
): GithubAgentResolution {
  const { store, secrets } = options
  const binding = options.assignmentForManager(managerId)
  const identityId = binding?.identityId ?? null
  if (
    !binding ||
    !identityId ||
    binding.injectCredentials === false ||
    store.manager.manager(managerId)?.status !== 'active'
  )
    return { state: 'host', identityId }
  const identity = secrets.identities().find((entry) => entry.identityId === identityId)
  if (!identity) return { state: 'broken', identityId, reason: 'github_identity_not_found' }
  const usable = identity.credentials.filter((credential) => {
    try {
      secrets.active(credential.credentialRef)
      return true
    } catch {
      return false
    }
  })
  const [only, ...more] = usable
  if (!only) return { state: 'broken', identityId, reason: 'github_agent_credential_unavailable' }
  if (more.length) return { state: 'broken', identityId, reason: 'github_agent_identity_ambiguous' }
  return { state: 'active', identityId, credentialRef: only.credentialRef }
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
      ![node, options.ghPath].every((path) => isAbsolute(path) && !/["\r\n\0]/.test(path)) ||
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
      return { env, resolution: { state: 'host', identityId: null }, dispose() {} }
    const resolution = this.resolve(actor.managerId)
    const raw = env.GIT_CONFIG_COUNT ?? '0'
    // broken 也装助手：注入的会话在凭据失效时由助手报错，不落回宿主 gh/Git。
    if (resolution.state === 'host' || !/^\d{1,3}$/.test(raw) || Number(raw) > 100)
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
          // 先清空宿主为 github.com 配的助手，只留设备助手；其他主机仍用宿主配置。
          // SSH 地址不走凭据助手，会用宿主 SSH 钥匙，所以改写成 HTTPS。
          GIT_CONFIG_COUNT: String(cfg + 4),
          [`GIT_CONFIG_KEY_${cfg}`]: 'credential.https://github.com.helper',
          [`GIT_CONFIG_VALUE_${cfg}`]: '',
          [`GIT_CONFIG_KEY_${cfg + 1}`]: 'credential.https://github.com.helper',
          [`GIT_CONFIG_VALUE_${cfg + 1}`]: `!${credential}`,
          [`GIT_CONFIG_KEY_${cfg + 2}`]: 'url.https://github.com/.insteadOf',
          [`GIT_CONFIG_VALUE_${cfg + 2}`]: 'git@github.com:',
          [`GIT_CONFIG_KEY_${cfg + 3}`]: 'url.https://github.com/.insteadOf',
          [`GIT_CONFIG_VALUE_${cfg + 3}`]: 'ssh://git@github.com/',
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
      const live = this.current(launch)
      for (const [owner, config] of launch.configs) {
        const fresh =
          'credential' in live && live.credential.metadata.credentialRef === owner
            ? live.credential
            : undefined
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

  /** 每次 gh/Git 取用时按当前代次重新判断；不看命令的运行目录和目标仓库。 */
  private current(launch: Launch): { credential: GithubCredentialSnapshot } | { error: string } {
    if (!this.authorized(launch.actor)) return { error: 'github_agent_not_authorized' }
    const resolved = this.resolve(launch.actor.managerId)
    if (resolved.state === 'host') return { error: 'github_agent_injection_off' }
    if (resolved.state === 'broken') return { error: resolved.reason }
    try {
      return { credential: this.options.secrets.active(resolved.credentialRef) }
    } catch {
      return { error: 'github_agent_credential_unavailable' }
    }
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
        if (!isGit && !isGh) {
          socket.end('{}')
          return
        }
        const current = launch ? this.current(launch) : { error: 'github_agent_not_authorized' }
        if ('error' in current) socket.end(JSON.stringify({ error: current.error }))
        else if (isGit) socket.end(JSON.stringify({ token: current.credential.token }))
        else if (launch) {
          socket.setTimeout(115_000)
          void this.ghConfig(socket, launch, request.key, current.credential)
        }
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
    initial: GithubCredentialSnapshot,
  ) {
    try {
      // 注入的会话第一次用 gh 时才下载受管 gh；Git 凭据回调不需要它。
      if (this.options.prepareGh) await this.options.prepareGh()
      if (socket.destroyed) return
      const current =
        typeof key === 'string' && this.launches.get(key) === launch
          ? this.current(launch)
          : undefined
      const credential = current && 'credential' in current ? current.credential : undefined
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
