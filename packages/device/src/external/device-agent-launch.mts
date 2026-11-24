// 管理器按线程解析实际分派，启动器只取得 gh/Git 的环境增量，不通过客户端 RPC。
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { adapterCliPath } from '../../../shared/src/adapter-cli.mjs'
import { deviceGithubEnvironmentSocket } from '../../../shared/src/device-github-environment.mjs'
import type { ExternalStore } from '../external-store.mjs'
import type { DeviceManagers } from '../manager.mjs'
import { isObject } from '../wire.mjs'
import { executableOnPath } from './device-agent-command.mjs'
import { agentCommandShim } from './device-agent-shim.mjs'
import type { ExternalDeviceConfiguration } from './device-configuration.mjs'
import { probeAgentGithubIdentity } from './execution-boundary.mjs'
import type { ManagedGithubCli } from './github/gh-install.mjs'
import type { ExternalGithubSecrets } from './secrets.mjs'
import { type GithubAgentActor, GithubAgentLoginService } from './secrets-agent-login.mjs'
import { ExternalPrivateFiles } from './secrets-files.mjs'

const execute = promisify(execFile)
const windows = process.platform === 'win32'

export class DeviceAgentLaunch {
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly leases = new Map<string, { dispose(): void; at: number }>()
  private readonly options: {
    deviceSocket: string
    stateDirectory: string
    managedCli: ManagedGithubCli
    managers: DeviceManagers
    store: ExternalStore
    secrets: ExternalGithubSecrets
    configuration: ExternalDeviceConfiguration
  }
  private login: GithubAgentLoginService | null = null
  private starting: Promise<GithubAgentLoginService | null> | null = null
  private closed = false
  private unknownUsers = false
  private probes = 0

  constructor(options: DeviceAgentLaunch['options']) {
    this.options = options
    this.server = createServer((socket) => this.serve(socket))
  }

  async start(): Promise<void> {
    const { deviceSocket, stateDirectory } = this.options
    const adapter = adapterCliPath()
    if (!adapter) throw new Error('external_agent_command_missing')
    const path = deviceGithubEnvironmentSocket(deviceSocket)
    if (!windows) rmSync(path, { force: true })
    await this.listen(path)
    const files = new ExternalPrivateFiles(join(stateDirectory, 'external-agent-gh', 'command'))
    for (const tool of ['gh', 'git'] as const) {
      const name = windows ? `${tool}.cmd` : tool
      files.write(name, agentCommandShim(files.directory, tool, adapter))
      if (!windows) chmodSync(files.path(name), 0o700)
    }
  }

  refresh(): void {
    this.login?.refresh()
  }

  private listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      const mask = windows ? undefined : process.umask(0o077)
      try {
        this.server.listen(path, resolve)
      } finally {
        if (mask !== undefined) process.umask(mask)
      }
    })
  }

  private service(): Promise<GithubAgentLoginService | null> {
    if (this.closed) return Promise.resolve(null)
    if (this.login) return Promise.resolve(this.login)
    if (this.starting) return this.starting
    const { configuration, deviceSocket, managedCli, managers, ...options } = this.options
    const callbackPath = windows
      ? `${deviceGithubEnvironmentSocket(deviceSocket)}-callback`
      : join(options.stateDirectory, 'gc.sock')
    this.starting = (async () => {
      if (this.closed) return null
      if (!windows) rmSync(callbackPath, { force: true })
      this.login = await GithubAgentLoginService.start({
        ...options,
        callbackPath,
        ghPath: managedCli.path,
        prepareGh: () => managedCli.ensure(),
        assignmentForManager: configuration.assignmentForManager,
        isWorklineCurrent: ({ threadId, managerId }) =>
          this.actor(threadId)?.managerId === managerId &&
          managers.lines.mark(threadId)?.role === 'line',
      })
      return this.login
    })()
      .catch(() => null)
      .finally(() => {
        this.starting = null
      })
    return this.starting
  }

  private actor(threadId: string, harness?: string): GithubAgentActor | null {
    const { managers } = this.options
    const mark = managers.lines.mark(threadId)
    const manager = mark && managers.store.manager(mark.managerId)
    const index = managers.tree.host.index
    if (
      manager?.status !== 'active' ||
      !mark ||
      index.archived(threadId) ||
      managers.resets.refusal(threadId) ||
      managers.resets.held(threadId)
    )
      return null
    const actual = mark.role === 'manager' ? manager.harness : index.lookup(threadId)
    if (!actual || (harness && harness !== actual)) return null
    return {
      kind: mark.role === 'manager' ? 'manager' : 'workline',
      managerId: manager.id,
      threadId,
    }
  }

  private async request(raw: unknown): Promise<unknown> {
    if (!isObject(raw) || this.closed) return {}
    if (raw.action === 'release' && typeof raw.lease === 'string') {
      if (raw.uncertain === true && this.leases.has(raw.lease)) this.unknownUsers = true
      this.release(raw.lease)
      return {}
    }
    // 只问这个会话是不是已注入（Gemini、Qwen 的工具前钩子据此决定要不要给命令写上会话号），不发租约。
    if (
      raw.action === 'probe' &&
      typeof raw.threadId === 'string' &&
      typeof raw.harness === 'string'
    ) {
      const actor = this.actor(raw.threadId, raw.harness)
      return {
        injected: !!actor && !!this.options.configuration.assignmentForManager(actor.managerId),
      }
    }
    if (
      raw.action !== 'start' ||
      typeof raw.threadId !== 'string' ||
      typeof raw.harness !== 'string' ||
      !isObject(raw.base)
    )
      return {}
    const actor = this.actor(raw.threadId, raw.harness)
    if (!actor || !this.options.configuration.assignmentForManager(actor.managerId)) return {}
    const base: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(raw.base))
      if (
        /^(?:PATH|GIT_CONFIG_COUNT)$/i.test(key) &&
        typeof value === 'string' &&
        value.length <= 16384
      )
        base[key] = value
    const login = await this.service()
    if (!login || this.closed || !this.actor(raw.threadId, raw.harness)) return {}
    const lease = login.environment(actor, base)
    // broken 也给租约：由助手报出凭据为何不可用，不让命令落回宿主 gh。
    if (lease.resolution.state === 'host' || !lease.ghPath) return {}
    const id = randomUUID()
    // 进程被硬杀时，定期释放不再由命令归还的句柄。
    this.sweep()
    if (this.leases.size >= 128) {
      lease.dispose()
      return {}
    }
    this.leases.set(id, { dispose: lease.dispose, at: Date.now() })
    return { lease: id, ghPath: lease.ghPath, ghArgs: lease.ghArgs, env: lease.env }
  }

  private release(id: string): void {
    this.leases.get(id)?.dispose()
    this.leases.delete(id)
  }

  sweep(): void {
    for (const [id, lease] of this.leases)
      if (Date.now() - lease.at > 3600_000) {
        this.unknownUsers = true
        this.release(id)
      }
  }

  private serve(socket: Socket): void {
    if (this.sockets.size >= 16) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(4000, () => socket.destroy())
    let buffer = ''
    socket.setEncoding('utf8')
    const data = (chunk: string) => {
      buffer += chunk
      if (buffer.length > 20000) {
        socket.destroy()
        return
      }
      if (!buffer.endsWith('\n')) return
      socket.off('data', data)
      void Promise.resolve()
        .then(() => this.request(JSON.parse(buffer)))
        .then(
          (result) => socket.end(JSON.stringify(result)),
          () => socket.destroy(),
        )
    }
    socket.on('data', data)
  }

  async probe(managerId: string, cwd: string, ownerUserId: string) {
    const manager = this.options.managers.store.manager(managerId)
    const login = manager && (await this.service())
    const scope =
      manager && login
        ? login.environment({ kind: 'manager', managerId, threadId: manager.threadId }, process.env)
        : null
    try {
      const ghPath = scope?.ghPath ?? executableOnPath('gh', process.env) ?? ''
      return await probeAgentGithubIdentity({
        ghPath,
        ownerUserId,
        launch: async ({ executable, args, signal }) => {
          this.probes++
          try {
            return (
              await execute(
                scope?.ghArgs ? process.execPath : executable,
                scope?.ghArgs ? [...scope.ghArgs, ...args] : args,
                { cwd, signal, env: scope?.env ?? process.env, maxBuffer: 128 * 1024 },
              )
            ).stdout
          } finally {
            if (signal.aborted) this.unknownUsers = true
            this.probes--
          }
        },
      })
    } finally {
      scope?.dispose()
    }
  }

  async close(): Promise<boolean> {
    this.closed = true
    const safeToRetire = !this.unknownUsers && this.leases.size === 0 && this.probes === 0
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
    for (const id of this.leases.keys()) this.release(id)
    await this.starting
    await this.login?.close()
    return safeToRetire
  }
}
