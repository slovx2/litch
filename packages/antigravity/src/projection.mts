import type { WireEvent } from './runtime.mjs'
import type { Thread, Turn } from './store.mjs'

export type Notify = (method: string, params: Record<string, unknown>) => void
export class Projection {
  readonly turn: Turn
  private readonly notify: Notify
  private readonly steps = new Map<string, any>()
  readonly tools = new Map<string, { name: string; item: any; finished: boolean }>()
  readonly completed = new Set<string>()
  constructor(turn: Turn, notify: Notify) {
    this.turn = turn
    this.notify = notify
  }
  add(item: any): void {
    this.turn.items.push(item)
    this.notify('item/started', { item, startedAtMs: Date.now() })
  }
  done(item: any): void {
    if (this.completed.has(item.id)) return
    this.completed.add(item.id)
    this.notify('item/completed', { item, completedAtMs: Date.now() })
  }
  tool(request: any, thread: Thread): any {
    const args = request.toolArgs ?? {}
    const id = `tool-${args.callId || request.requestId}`
    const existing = this.tools.get(id)
    if (existing) return existing.item
    let input: any = args.arguments ?? {}
    if (args.argumentsJson)
      try {
        input = JSON.parse(args.argumentsJson)
      } catch {
        input = {}
      }
    const name = String(args.toolName ?? 'unknown')
    const file = ['create_file', 'edit_file'].includes(name)
    const item: any = file
      ? {
          type: 'fileChange',
          id,
          changes: [
            {
              path: String(input.TargetFile ?? input.AbsolutePath ?? ''),
              kind: {
                type: name === 'create_file' ? 'add' : 'update',
                ...(name === 'create_file' ? {} : { move_path: null }),
              },
              diff:
                name === 'create_file' ? String(input.CodeContent ?? '') : JSON.stringify(input),
            },
          ],
          status: 'inProgress',
        }
      : {
          type: 'commandExecution',
          id,
          command: String(input.CommandLine ?? `${name} ${JSON.stringify(input)}`),
          cwd: String(input.Cwd ?? thread.cwd),
          processId: null,
          source: 'agent',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        }
    this.tools.set(id, { name, item, finished: false })
    this.add(item)
    return item
  }
  deny(item: any): void {
    item.status = 'declined'
    const tool = this.tools.get(item.id)
    if (tool) tool.finished = true
    this.done(item)
  }
  step(step: WireEvent): void {
    if (step.parentTrajectoryId) return
    const key = `${step.trajectoryId}:${step.stepIndex ?? 0}`
    if (step.source === 'SOURCE_MODEL' && step.target === 'TARGET_USER') {
      let item = this.steps.get(key)
      if (!item) {
        item = { type: 'agentMessage', id: `message-${key}`, text: '', phase: null }
        this.steps.set(key, item)
        this.add(item)
      }
      const next = typeof step.text === 'string' ? step.text : item.text + (step.textDelta ?? '')
      const delta = next.startsWith(item.text)
        ? next.slice(item.text.length)
        : String(step.textDelta ?? '')
      item.text = next
      if (delta) this.notify('item/agentMessage/delta', { itemId: item.id, delta })
      if (step.state === 'STATE_DONE' || step.state === 'STATE_ERROR') this.done(item)
      return
    }
    const actions: Record<string, string[]> = {
      runCommand: ['run_command'],
      createFile: ['create_file'],
      editFile: ['edit_file'],
      viewFile: ['view_file'],
      listDirectory: ['list_directory'],
      findFile: ['find_file'],
      searchDirectory: ['search_directory'],
    }
    for (const [field, names] of Object.entries(actions)) {
      if (!step[field]) continue
      // SDK 的审批 stepIndex 与执行 stepIndex 不保证相同，按同一回合待执行的工具匹配。
      let item = this.steps.get(key)
      if (!item) {
        const tool = [...this.tools.values()].find(
          (entry) =>
            names.includes(entry.name) &&
            !entry.finished &&
            ![...this.steps.values()].includes(entry.item),
        )
        if (!tool) continue
        item = tool.item
        this.steps.set(key, item)
      }
      if (step.runCommand) {
        item.aggregatedOutput = step.runCommand.combinedOutput ?? null
        item.exitCode = step.runCommand.exitCode ?? null
      }
      if (step.state === 'STATE_DONE' || step.state === 'STATE_ERROR') {
        item.status = step.state === 'STATE_ERROR' ? 'failed' : 'completed'
        const tool = this.tools.get(item.id)
        if (tool) tool.finished = true
        this.done(item)
      }
    }
  }
  finish(): void {
    for (const item of this.turn.items) {
      if (this.completed.has(item.id)) continue
      if ('status' in item) item.status = this.turn.status === 'completed' ? 'completed' : 'failed'
      this.done(item)
    }
  }
}
