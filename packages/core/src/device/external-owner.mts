import type {
  ExternalOwner,
  ExternalOwnerIdentity,
} from '../../../protocol/src/external-sources.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { ConfigMainRequest, ConfigMainResult } from '../model-config.mjs'
import { phrase } from '../phrase.mjs'
import type {
  ExternalCommands,
  ExternalOwnerInput,
  ExternalOwnerSyncRow,
  GlobalExternalOwner,
} from '../projection/external.mjs'

interface OwnerHost {
  main(request: ConfigMainRequest): Promise<ConfigMainResult>
  devices(): { id: string; online: boolean }[]
  get(deviceId: string): Promise<ExternalOwner | null>
  set(
    deviceId: string,
    params: {
      owner: ExternalOwnerIdentity
      expectedRevision: number
      operationId: string
    },
  ): Promise<ExternalOwner>
}

const loginPattern = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
const profilePattern = new RegExp(`^https://github\\.com/(${loginPattern})/?$`, 'u')
export const githubProfileLogin = (value: string) => profilePattern.exec(value)?.[1]
export const githubNumericId = (value: string) => /^[1-9][0-9]{0,39}$/u.test(value)
export function isExternalOwnerIdentity(value: unknown): value is ExternalOwnerIdentity {
  if (!value || typeof value !== 'object') return false
  const owner = value as Partial<ExternalOwnerIdentity>
  return (
    owner.provider === 'github' &&
    typeof owner.userId === 'string' &&
    githubNumericId(owner.userId) &&
    typeof owner.loginCache === 'string' &&
    typeof owner.profileUrl === 'string' &&
    githubProfileLogin(owner.profileUrl)?.toLowerCase() === owner.loginCache.toLowerCase() &&
    ['localGh', 'profileUrl', 'userId'].includes(owner.method ?? '')
  )
}

const invalid = () =>
  new ChannelError('invalid', 'Invalid GitHub identity', phrase('external.invalidOwner'))
const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0
const unsupported = () =>
  new ChannelError(
    'unsupported',
    'External account bridge is unavailable',
    phrase('external.unsupported'),
  )

export function createExternalOwner(host: OwnerHost) {
  let queue = Promise.resolve()

  async function get(): Promise<GlobalExternalOwner | null> {
    const result = await host.main({ kind: 'external.owner.get' })
    if (!result.ok) throw unsupported()
    const data = result.data as GlobalExternalOwner | null
    return data && isExternalOwnerIdentity(data.owner) && validRevision(data.revision) ? data : null
  }

  async function resolve(input: ExternalOwnerInput): Promise<ExternalOwnerIdentity> {
    if (
      !input ||
      !(
        input.method === 'localGh' ||
        (typeof input.value === 'string' &&
          (input.method === 'profileUrl'
            ? githubProfileLogin(input.value.trim())
            : input.method === 'userId' && githubNumericId(input.value.trim())))
      )
    )
      throw invalid()
    const result = await host.main({ kind: 'external.owner.resolve', input })
    if (!result.ok || !isExternalOwnerIdentity(result.data))
      throw new ChannelError(
        'remote',
        'GitHub identity could not be resolved',
        phrase(input.method === 'localGh' ? 'external.resolveGhFailed' : 'external.resolveFailed'),
      )
    return result.data
  }

  async function examine(
    device: { id: string; online: boolean },
    owner: ExternalOwnerIdentity,
  ): Promise<ExternalOwnerSyncRow> {
    const deviceId = device.id
    if (!device.online) return { deviceId, state: 'offline', owner: null, expectedRevision: null }
    try {
      const existing = await host.get(deviceId)
      return {
        deviceId,
        owner: existing,
        expectedRevision: existing?.revision ?? 0,
        state: existing?.userId === owner.userId ? 'synced' : 'different',
      }
    } catch (error) {
      return {
        deviceId,
        owner: null,
        expectedRevision: null,
        state:
          error instanceof ChannelError && error.code === 'unsupported' ? 'unsupported' : 'failed',
      }
    }
  }

  const plan = (owner: ExternalOwnerIdentity) => {
    if (!isExternalOwnerIdentity(owner)) throw invalid()
    return Promise.all(host.devices().map((device) => examine(device, owner)))
  }

  function set(input: ExternalCommands['external.owner.global.set']['params']) {
    const run = queue.then(async () => {
      if (
        !isExternalOwnerIdentity(input.owner) ||
        !validRevision(input.expectedRevision) ||
        typeof input.operationId !== 'string' ||
        input.operationId.length > 96 ||
        !input.operationId ||
        !Array.isArray(input.devices) ||
        input.devices.some(
          (one) => typeof one.deviceId !== 'string' || !validRevision(one.expectedRevision),
        )
      )
        throw invalid()
      const versions = new Map(input.devices.map((row) => [row.deviceId, row.expectedRevision]))
      const placed = await host.main({
        kind: 'external.owner.save',
        owner: input.owner,
        expectedRevision: input.expectedRevision,
      })
      if (!placed.ok) {
        if (placed.reason === 'conflict')
          throw new ChannelError(
            'conflict',
            'Global owner changed',
            phrase('external.ownerConflict'),
          )
        throw unsupported()
      }
      const global = { owner: input.owner, revision: input.expectedRevision + 1 }
      const rows = await plan(input.owner)
      const devices = await Promise.all(
        rows.map(async (row): Promise<ExternalOwnerSyncRow> => {
          const expectedRevision = versions.get(row.deviceId)
          if (
            row.state !== 'different' ||
            expectedRevision === undefined ||
            row.expectedRevision !== expectedRevision
          )
            return row
          try {
            const owner = await host.set(row.deviceId, {
              owner: input.owner,
              expectedRevision,
              operationId: input.operationId,
            })
            return { ...row, owner, expectedRevision: owner.revision, state: 'synced' }
          } catch {
            return examine(
              {
                id: row.deviceId,
                online: host.devices().some((one) => one.id === row.deviceId && one.online),
              },
              input.owner,
            )
          }
        }),
      )
      return { global, devices }
    })
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  return { get, resolve, plan, set }
}
