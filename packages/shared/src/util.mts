import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function defaultSocketPath(): string {
  const path = join(
    resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    'app-server-control',
    'app-server-control.sock',
  )
  return path.length <= (process.platform === 'darwin' ? 104 : 108)
    ? path
    : join(tmpdir(), `ccx-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.sock`)
}

export const newId = randomUUID
export const nowSeconds = () => Math.floor(Date.now() / 1000)
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

type Logger = (event: string, data: Record<string, unknown>) => void
let logger: Logger = () => {}
export function setSharedLogger(value: Logger): void {
  logger = value
}
export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  logger(event, data)
}
