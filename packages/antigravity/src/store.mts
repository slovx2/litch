import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadNotFound } from '../../shared/src/protocol-contract.mjs'

export interface Turn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: any
}
export interface Thread {
  id: string
  cwd: string
  model: string
  baseUrl: string
  instructions: string
  createdAt: number
  updatedAt: number
  preview: string
  turns: Turn[]
}
export class Store {
  readonly threads = new Map<string, Thread>()
  readonly directory: string
  constructor(home: string) {
    this.directory = join(home, 'threads')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    for (const filename of readdirSync(this.directory).filter((name) => name.endsWith('.json'))) {
      const thread = JSON.parse(readFileSync(join(this.directory, filename), 'utf8')) as Thread
      if (!thread.id || filename !== `${thread.id}.json` || !Array.isArray(thread.turns))
        throw new Error('Antigravity 会话索引损坏')
      for (const turn of thread.turns)
        if (turn.status === 'inProgress') {
          turn.status = 'failed'
          turn.error = {
            message: '引擎在回合结束前停止',
            codexErrorInfo: null,
            additionalDetails: null,
          }
        }
      this.threads.set(thread.id, thread)
      this.save(thread)
    }
  }
  get(id: string): Thread {
    const thread = this.threads.get(id)
    if (!thread) throw new ThreadNotFound(id)
    return thread
  }
  save(thread: Thread): void {
    const path = join(this.directory, `${thread.id}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify(thread), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    this.threads.set(thread.id, thread)
  }
}
export function envelope(thread: Thread, includeTurns: boolean): any {
  const active = thread.turns.at(-1)?.status === 'inProgress'
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    preview: thread.preview,
    name: null,
    modelProvider: 'agy',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    historyMode: 'legacy',
    threadSource: 'user',
    section: null,
    sectionEnteredAt: null,
    canAcceptDirectInput: true,
    status: active ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    path: null,
    cwd: thread.cwd,
    cliVersion: '0.1.23',
    source: 'appServer',
    parentThreadId: null,
    ephemeral: false,
    gitInfo: null,
    agentNickname: null,
    agentRole: null,
    turns: includeTurns ? thread.turns : [],
    projectId: null,
  }
}
export function settings(thread: Thread): any {
  return {
    thread: envelope(thread, true),
    model: thread.model,
    modelProvider: 'agy',
    cwd: thread.cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    activePermissionProfile: { id: ':danger-full-access', extends: null },
    reasoningEffort: null,
  }
}
