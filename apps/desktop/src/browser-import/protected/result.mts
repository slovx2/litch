import { setImmediate } from 'node:timers/promises'
import type { ProtectedKindResult, ProtectedStatus } from './types.mjs'

export class ReadFault extends Error {
  readonly status: ProtectedStatus
  constructor(status: ProtectedStatus) {
    super(messages[status])
    this.status = status
  }
}

const messages: Record<ProtectedStatus, string> = {
  ok: 'Import data read successfully.',
  partial: 'Some records could not be read.',
  missing: 'No records were found.',
  locked: 'Source files are busy or changed during copying. Close the source browser and retry.',
  denied: 'Access to protected data was denied.',
  'needs-elevation': 'Application-bound data requires administrator consent.',
  unsupported: 'This protected data format or authentication method is not supported.',
  cancelled: 'Import was cancelled.',
  failed: 'Protected data could not be read.',
}

// 外部异常可能带路径、数据库内容或子进程输出，绝不透传 message/cause。
export function faultStatus(error: unknown): ProtectedStatus {
  if (error instanceof ReadFault) return error.status
  const sqliteCode = (error as { errcode?: unknown } | null)?.errcode
  // node:sqlite 用 ERR_SQLITE_ERROR 配数字错误码；只读快照遇到待恢复事务也要求关浏览器重试。
  if (typeof sqliteCode === 'number' && [5, 6, 8].includes(sqliteCode & 0xff)) return 'locked'
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  if (code === 'EBUSY' || code === 'ETXTBSY' || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return 'locked'
  if (code === 'ABORT_ERR') return 'cancelled'
  return 'failed'
}

export function failure<T>(status: ProtectedStatus): ProtectedKindResult<T> {
  return { status, discovered: 0, items: [], failed: 0, error: messages[status] }
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ReadFault('cancelled')
}

export async function checkpoint(signal: AbortSignal): Promise<void> {
  await setImmediate()
  checkCancelled(signal)
}

// 一类可以包含多个库；一个库读不到不能盖掉另一个库读出的记录。
export class Records<T> {
  discovered = 0
  failed = 0
  items: T[] = []
  statuses: ProtectedStatus[] = []

  issue(error: unknown, record = false): void {
    const status = faultStatus(error)
    if (status === 'cancelled') throw new ReadFault(status)
    if (record) this.failed++
    if (status !== 'missing' || record) this.statuses.push(status)
  }

  finish(): ProtectedKindResult<T> {
    const priority: ProtectedStatus[] = [
      'cancelled',
      'denied',
      'needs-elevation',
      'locked',
      'unsupported',
      'failed',
      'missing',
    ]
    const problem = priority.find((value) => this.statuses.includes(value))
    const status = problem
      ? this.items.length
        ? 'partial'
        : problem
      : this.failed
        ? this.items.length
          ? 'partial'
          : 'failed'
        : this.discovered
          ? 'ok'
          : 'missing'
    return {
      status,
      discovered: this.discovered,
      items: this.items,
      failed: this.failed,
      ...(problem || this.failed ? { error: messages[problem ?? status] } : {}),
    }
  }
}
