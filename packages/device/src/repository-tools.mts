import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  REPOSITORY_METHODS,
  REPOSITORY_NAMESPACE,
  type RepositoryMethod,
} from '../../protocol/src/client-tools-repository.mjs'
import { ReadCommandError } from '../../shared/src/read-only-command.mjs'
import type { DeviceToolCall, DeviceToolHandler } from './device-tools.mjs'
import type { DeviceManagers } from './manager.mjs'
import { queryRepository, type RepositoryQueryResult } from './repository-query.mjs'
import { insideRepository, requireLocalRepositoryPath } from './repository-view.mjs'
import { isObject } from './wire.mjs'

const PAGE_CHARS = 12000
interface Snapshot {
  directory: string
  owner: string
  method: string
  result: RepositoryQueryResult
  offset: number
  expires: number
}
const ok = (value: unknown): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ReadCommandError('cancelled', 'Query cancelled or timed out.'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

export class RepositoryTools {
  private readonly managers: DeviceManagers
  private readonly pages = new Map<string, Snapshot>()
  private running = 0
  constructor(managers: DeviceManagers) {
    this.managers = managers
  }

  private async authorize(call: DeviceToolCall, directory: unknown): Promise<string> {
    if (typeof directory !== 'string' || !isAbsolute(directory))
      throw new ReadCommandError('invalid', 'directory must be absolute.')
    requireLocalRepositoryPath(directory)
    const questions = this.managers.questions
    const temporary = questions.managerFor(call.threadId)
    const manager = temporary
      ? this.managers.store.manager(temporary)
      : this.managers.store.forThread(call.threadId)
    if (
      !manager ||
      manager.harness !== call.harness ||
      manager.status !== 'active' ||
      !questions.allowed(call.threadId, REPOSITORY_NAMESPACE, call.tool)
    )
      throw new ReadCommandError(
        'forbidden',
        'Only an active manager or its active temporary question may query repositories.',
      )
    const ids = temporary
      ? questions.readableSessions(call.threadId)
      : questions.ownedSessions(manager.id)
    if (!ids?.has(manager.threadId))
      throw new ReadCommandError('forbidden', 'The temporary question has retired.')
    const target = realpathSync(directory)
    const roots = new Map([[manager.threadId, manager.cwd]])
    for (const id of ids) {
      if (id === manager.threadId) continue
      const found = await this.managers.tree.read(id, false).catch(() => null)
      if (typeof found?.thread.cwd === 'string') roots.set(id, found.thread.cwd)
    }
    if (
      ![...roots].some(([id, root]) => {
        if (!questions.ownedSessions(manager.id).has(id)) return false
        try {
          return insideRepository(realpathSync(root), target)
        } catch {
          return false
        }
      })
    )
      throw new ReadCommandError(
        'path_denied',
        'Select a repository inside this manager or a currently owned workline directory.',
      )
    if (!questions.allowed(call.threadId, REPOSITORY_NAMESPACE, call.tool))
      throw new ReadCommandError('forbidden', 'The temporary question has retired.')
    return target
  }
  private page(id: string, snapshot: Snapshot) {
    const { content, ...metadata } = snapshot.result
    const start = snapshot.offset
    snapshot.offset = Math.min(content.length, start + PAGE_CHARS)
    if (
      snapshot.offset < content.length &&
      /[\uD800-\uDBFF]/.test(content[snapshot.offset - 1] ?? '')
    )
      snapshot.offset--
    const more = snapshot.offset < content.length
    if (!more) this.pages.delete(id)
    return {
      ...metadata,
      content: content.slice(start, snapshot.offset),
      next_cursor: more ? id : null,
      output_chars: content.length,
      offset: start,
    }
  }
  readonly handle: DeviceToolHandler = async (call, { signal }) => {
    try {
      if (!(REPOSITORY_METHODS as readonly string[]).includes(call.tool))
        throw new ReadCommandError('invalid', 'Unknown repository method.')
      if (!isObject(call.arguments))
        throw new ReadCommandError('invalid', 'Expected structured query arguments.')
      const args = call.arguments
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)])
      for (const [id, snapshot] of this.pages)
        if (snapshot.expires < Date.now()) this.pages.delete(id)
      if (args.cursor !== undefined) {
        if (Object.keys(args).length !== 1 || typeof args.cursor !== 'string')
          throw new ReadCommandError('invalid', 'Supply only cursor to continue.')
        const snapshot = this.pages.get(args.cursor)
        if (!snapshot || snapshot.owner !== call.threadId || snapshot.method !== call.tool)
          throw new ReadCommandError(
            'invalid_cursor',
            'This output cursor is unavailable or belongs to another session/query.',
          )
        await withinDeadline(this.authorize(call, snapshot.directory), bounded)
        return ok(this.page(args.cursor, snapshot))
      }
      if (this.running >= 2)
        throw new ReadCommandError(
          'busy',
          'Two repository queries are already running; retry after they finish.',
        )
      this.running++
      try {
        const directory = await withinDeadline(this.authorize(call, args.directory), bounded)
        const result = await queryRepository(
          call.tool as RepositoryMethod,
          { ...args, directory },
          bounded,
        )
        await withinDeadline(this.authorize(call, directory), bounded)
        const id = randomUUID()
        const snapshot: Snapshot = {
          directory,
          owner: call.threadId,
          method: call.tool,
          result,
          offset: 0,
          expires: Date.now() + 120000,
        }
        while (this.pages.size >= 8) this.pages.delete(this.pages.keys().next().value as string)
        this.pages.set(id, snapshot)
        return ok(this.page(id, snapshot))
      } finally {
        this.running--
      }
    } catch (error) {
      if (error instanceof ReadCommandError)
        return { ...ok({ error: { code: error.code, message: error.message } }), success: false }
      return clientToolFailure('failed', error instanceof Error ? error.message : String(error))
    }
  }
}
