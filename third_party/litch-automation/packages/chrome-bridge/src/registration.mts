import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  NativeHostRegistration,
  RegistrationPlan,
  RegistrationPolicy,
  RegistrationState,
  RegistrationStore,
} from '../../automation-contracts/src/chrome.mjs'

/** 默认只更新同一路径归属的登记；同名的其他宿主必须由可信策略明确处理。 */
export const sameOwnerPolicy: RegistrationPolicy = {
  async decide(current, desired, signal) {
    signal.throwIfAborted()
    if (current.registration && current.registration.ownerId !== desired.ownerId)
      return {
        decision: 'deny',
        reason: 'Native host name is already owned by another application.',
      }
    return { decision: 'apply', plan: { expectedRevision: current.revision, desired } }
  },
}

/**
 * 每用户 manifest 目录适配器。ownerId 是启动器的绝对路径，原有无侧车的登记也可核对归属。
 * 锁只协调使用本适配器的写入者；外部安装器不遵守锁时仍可能竞态，宿主应保证安装互斥。
 */
export class FileRegistrationStore implements RegistrationStore {
  readonly directory: string
  readonly description: string
  constructor(directory: string, description: string) {
    if (!isAbsolute(directory)) throw new Error('Registration directory must be absolute')
    this.directory = directory
    this.description = description
  }
  private file(hostName: string): string {
    if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(hostName)) throw new Error('Invalid native host name')
    return join(this.directory, `${hostName}.json`)
  }
  async inspect(hostName: string): Promise<RegistrationState> {
    const file = this.file(hostName)
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return { registration: null, revision: 'absent' }
    if (!info.isFile() || info.size > 8192) throw new Error('Unsafe native host registration')
    const bytes = await readFile(file)
    const value = JSON.parse(bytes.toString('utf8'))
    if (
      value.name !== hostName ||
      !isAbsolute(value.path) ||
      value.type !== 'stdio' ||
      !Array.isArray(value.allowed_origins) ||
      value.allowed_origins.some(
        (origin: unknown) =>
          typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin),
      )
    )
      throw new Error('Invalid existing native host registration')
    return {
      revision: createHash('sha256').update(bytes).digest('hex'),
      registration: {
        hostName,
        executable: value.path,
        ownerId: value.path,
        extensionIds: value.allowed_origins.map((origin: string) => origin.slice(19, -1)),
      },
    }
  }
  private async locked<T>(hostName: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lockPath = `${this.file(hostName)}.lock`
    const lock = await open(lockPath, 'wx', 0o600)
    try {
      return await work()
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
  }
  async apply(plan: RegistrationPlan, signal: AbortSignal): Promise<RegistrationState> {
    const desired = plan.desired
    return this.locked(desired.hostName, async () => {
      signal.throwIfAborted()
      const current = await this.inspect(desired.hostName)
      if (current.revision !== plan.expectedRevision)
        throw new Error('Native host registration changed')
      if (
        desired.ownerId !== desired.executable ||
        !isAbsolute(desired.executable) ||
        !desired.extensionIds.length ||
        desired.extensionIds.some((id) => !/^[a-p]{32}$/.test(id))
      )
        throw new Error('Invalid native host registration plan')
      const file = this.file(desired.hostName)
      const temporary = `${file}.${randomUUID()}.new`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(
          `${JSON.stringify(
            {
              name: desired.hostName,
              description: this.description,
              path: desired.executable,
              type: 'stdio',
              allowed_origins: desired.extensionIds.map((id) => `chrome-extension://${id}/`),
            },
            null,
            2,
          )}\n`,
        )
        await handle.close()
        signal.throwIfAborted()
        await rename(temporary, file)
      } finally {
        await handle.close().catch(() => {})
        await unlink(temporary).catch(() => {})
      }
      return this.inspect(desired.hostName)
    })
  }
  async remove(hostName: string, ownerId: string, expectedRevision: string): Promise<boolean> {
    return this.locked(hostName, async () => {
      const current = await this.inspect(hostName)
      if (current.revision !== expectedRevision || current.registration?.ownerId !== ownerId)
        return false
      await unlink(this.file(hostName))
      return true
    })
  }
}

export async function applyRegistration(
  store: RegistrationStore,
  policy: RegistrationPolicy,
  desired: NativeHostRegistration,
  signal: AbortSignal,
): Promise<RegistrationState> {
  const decision = await policy.decide(await store.inspect(desired.hostName), desired, signal)
  if (decision.decision === 'deny') throw new Error(decision.reason)
  // 策略只决定是否接管，不能偷换请求的身份、路径或扩展白名单。
  if (JSON.stringify(decision.plan.desired) !== JSON.stringify(desired))
    throw new Error('Registration policy changed identity')
  return store.apply(decision.plan, signal)
}
