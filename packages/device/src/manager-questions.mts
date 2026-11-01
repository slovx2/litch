// 旁问由设备持有连接与记录，窗口关闭不丢问答；分叉不登记为工作线。
import { randomUUID } from 'node:crypto'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import type { Manager } from '../../protocol/src/manager.mjs'
import type { ManagerPost, ManagerPostId } from '../../protocol/src/manager-posts.mjs'
import {
  forwardedManagerQuestion,
  managerQuestionRules,
} from '../../protocol/src/manager-question.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { DeviceManagers } from './manager.mjs'
import { managerNow, type QuestionState } from './manager-store.mjs'
import { fields, invalid, ManagerError } from './manager-validate.mjs'
import { lastAnswer } from './session-tree.mjs'
import { isObject } from './wire.mjs'

function currentQuestion(state: QuestionState) {
  const entry = state.discussion.messages.at(-1)
  if (!entry) throw new Error('The background question is missing.')
  return entry
}

export function questionSnapshot(turns: Record<string, unknown>[]) {
  const running = turns.find((turn) => turn.status === 'inProgress')
  const completed = (running ? turns.slice(0, turns.indexOf(running)) : turns).at(-1)
  return {
    source: typeof completed?.id === 'string' ? completed.id : '',
    position: running
      ? { beforeTurnId: running.id }
      : completed
        ? { lastTurnId: completed.id }
        : {},
  }
}

export class ManagerQuestions {
  readonly owner: DeviceManagers
  private readonly links = new Map<string, Promise<EngineLink>>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly restricted = new Map<string, string>()
  private readonly activeTurns = new Map<string, string>()
  private readonly releasing = new Set<string>()
  private readonly retired = new Set<string>()
  private closed = false

  constructor(owner: DeviceManagers) {
    this.owner = owner
    // 临时分叉不能跨设备进程恢复；问答原文留下，下次重新建分叉并附引文。
    for (const state of owner.store.questions()) {
      for (const id of state.threads) this.restricted.set(id, state.managerId)
      state.threadId = null
      for (const entry of state.discussion.messages)
        if (entry.status === 'running' && entry.mode !== 'manager') entry.status = 'failed'
      owner.store.saveQuestion(state)
    }
  }
  managerFor(threadId: string): string | undefined {
    return this.restricted.get(threadId)
  }
  allowed(threadId: string, namespace: unknown, tool: unknown): boolean {
    return (
      !this.restricted.has(threadId) ||
      (namespace === 'litch_manager' &&
        ['summary', 'get', 'update', 'close', 'post_get', 'post_reply'].includes(String(tool)))
    )
  }
  validateWrite(threadId: string, tool: string, given: unknown): void {
    if (!['update', 'close', 'post_reply'].includes(tool)) return
    const managerId = this.restricted.get(threadId)
    const state = this.owner.store.questions(managerId).find((one) => one.threadId === threadId)
    const args = fields(given)
    if (
      !state ||
      this.retired.has(threadId) ||
      (tool !== 'post_reply' && args.kind !== 'decision') ||
      args.id !== state.decisionId
    )
      invalid('A temporary question may change only its own decision while its session is active.')
    if (tool === 'post_reply' && (args.text !== undefined || args.questionId !== undefined))
      invalid('Temporary conversations may only update the original post; return replies normally.')
    if (
      tool === 'update' &&
      Object.keys(fields(args.patch)).some(
        (key) => !['title', 'background', 'options', 'recommend'].includes(key),
      )
    )
      invalid('Temporary questions may update only title, background, options and recommend.')
    if (tool === 'close' && !['expired', 'withdrawn'].includes(String(args.status)))
      invalid('Temporary questions may only expire or withdraw their own decision.')
  }
  noteChange(threadId: string, result: unknown): void {
    const managerId = this.restricted.get(threadId)
    if (!managerId) return
    const manager = this.owner.manager(managerId)
    const object = fields(fields(result).post ?? fields(result).object)
    // 不调用 check/wake；未唤醒的普通备注在经理下一回合开始时带入。
    this.owner.tree.store.addNote(
      manager.threadId,
      {
        threadId,
        title: `Issue ${object.id} updated in a temporary question`,
        status: 'completed',
        excerpt: `The user’s temporary conversation changed ${object.id}. Read litch_manager.post_get for the current post and history. ${JSON.stringify(object)}`,
      },
      false,
    )
  }
  private async link(manager: Manager): Promise<EngineLink> {
    let pending = this.links.get(manager.harness)
    if (!pending) {
      pending = this.owner.tree.host.openEngineLink(manager.harness)
      this.links.set(manager.harness, pending)
      pending.then(
        (link) => {
          link.onClose(() => {
            this.links.delete(manager.harness)
            if (this.closed) return
            for (const state of this.owner.store.questions()) {
              if (this.owner.store.manager(state.managerId)?.harness !== manager.harness) continue
              state.threadId = null
              this.owner.store.saveQuestion(state)
            }
          })
        },
        () => this.links.delete(manager.harness),
      )
    }
    return pending
  }
  private decision(managerId: string, id: ManagerPostId): ManagerPost {
    this.owner.writer.active(managerId)
    return this.owner.posts.get(managerId, id)
  }
  async ask(managerId: string, id: ManagerPostId, revision: number, question: string) {
    const decision = this.decision(managerId, id)
    if (decision.revision !== revision)
      throw new ManagerError('invalidManager', 'The decision changed; read it before asking again.')
    const key = `${managerId}/${id}`
    if (
      this.jobs.has(key) ||
      this.owner.store
        .question(managerId, id)
        ?.discussion.messages.some((entry) => entry.status === 'running')
    )
      throw new ManagerError('invalidManager', 'A background answer is still running.')
    if (question.length > 20000)
      throw new ManagerError('invalidManager', 'The question is too long.')
    const state: QuestionState = this.owner.store.question(managerId, id) ?? {
      managerId,
      decisionId: id,
      threadId: null,
      threads: [],
      source: '',
      revision: 0,
      discussion: { messages: [], light: false, summary: null, forwarded: 0 },
    }
    state.discussion.messages.push({
      id: randomUUID(),
      mode: 'temporary',
      question,
      answer: null,
      status: 'running',
      refreshed: false,
      at: managerNow(),
    })
    state.discussion.summary = null
    this.owner.store.saveQuestion(state)
    const job = this.run(state, decision)
      .catch(async (error) => {
        const entry = currentQuestion(state)
        entry.status = 'failed'
        entry.answer = error instanceof Error ? error.message : String(error)
        const link = await this.links.get(this.owner.manager(managerId).harness)?.catch(() => null)
        if (link) await this.release(state, link)
        else state.threadId = null
        this.save(state)
      })
      .finally(() => {
        this.jobs.delete(key)
        this.releaseClosed(managerId)
      })
    this.jobs.set(key, job)
    this.owner.changed(managerId)
    return { discussion: state.discussion }
  }
  private save(state: QuestionState): void {
    if (this.closed) return
    this.owner.store.transaction(() => {
      this.owner.store.saveQuestion(state)
      this.owner.store.record(
        state.managerId,
        state.decisionId,
        'device',
        null,
        { discussion: state.discussion },
        'Decision background conversation updated',
      )
    })
    this.owner.changed(state.managerId)
  }
  private async run(state: QuestionState, decision: ManagerPost): Promise<void> {
    const manager = this.owner.manager(state.managerId)
    const link = await this.link(manager)
    const features = isObject(link.runtime?.features) ? link.runtime.features : {}
    // 没有可强制的工具边界时拒绝，不能用提示词假装只读。
    if (!link.native && features.managerQuestions !== true)
      throw new Error(
        'This harness cannot enforce read-only background questions. Ask the manager in chat.',
      )
    const read = await link.request('thread/read', {
      threadId: manager.threadId,
      includeTurns: true,
    })
    const turns = Array.isArray(read?.thread?.turns) ? read.thread.turns : []
    const snapshot = questionSnapshot(turns)
    const fork = link.native || features.ephemeralFork === true
    const previous = state.discussion.messages.slice(0, -1)
    const { discussion: _discussion, ...backgroundDecision } = decision
    const entry = currentQuestion(state)
    const replace =
      !state.threadId ||
      (fork && (state.revision !== decision.revision || state.source !== snapshot.source))
    let prompt = entry.question
    if (replace) {
      entry.refreshed =
        previous.length > 0 &&
        (state.revision !== decision.revision || (fork && state.source !== snapshot.source))
      await this.release(state, link)
      const tools = [
        {
          ...MANAGER_TOOLS,
          description:
            'Explain this post. Read post_get; use post_reply patch only to update the current post. Do not change other objects.',
          instructions: managerQuestionRules(decision.id),
          tools: MANAGER_TOOLS.tools.filter((tool) =>
            ['summary', 'get', 'update', 'close', 'post_get', 'post_reply'].includes(tool.name),
          ),
        },
      ]
      const nativeConfig = link.native ? await this.nativeConfig(link, manager.cwd) : undefined
      const created = await link.request(fork ? 'thread/fork' : 'thread/start', {
        ...(fork ? { threadId: manager.threadId, ...snapshot.position } : { cwd: manager.cwd }),
        ...(manager.model ? { model: manager.model } : {}),
        ephemeral: true,
        excludeTurns: true,
        dynamicTools: tools,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ...(nativeConfig
          ? { config: nativeConfig, developerInstructions: managerQuestionRules(decision.id) }
          : {}),
      })
      if (typeof created?.thread?.id !== 'string')
        throw new Error('No background session was created.')
      state.threadId = created.thread.id
      state.threads.push(created.thread.id)
      this.restricted.set(created.thread.id, manager.id)
      state.source = snapshot.source
      state.revision = decision.revision
      state.discussion.light = !fork
      this.owner.store.saveQuestion(state)
      prompt = [
        managerQuestionRules(decision.id),
        fork
          ? ''
          : 'You have no manager conversation history. Say when the supplied context is insufficient.',
        `Decision and board context (reference only):\n${JSON.stringify({
          decision: backgroundDecision,
          situation: this.owner.store.situation(manager.id),
          objects: fork
            ? undefined
            : this.owner.store.objects(manager.id).map((object) => {
                const { discussion: _history, ...fields } = object as unknown as ManagerPost
                return fields
              }),
        })}`,
        previous.length
          ? `Earlier questions and answers (quoted reference):\n${JSON.stringify(previous)}`
          : '',
        `Current question:\n${entry.question}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    } else if (state.revision !== decision.revision) {
      entry.refreshed = true
      state.revision = decision.revision
      prompt = `Updated decision (reference only):\n${JSON.stringify(backgroundDecision)}\n\n${entry.question}`
      this.owner.store.saveQuestion(state)
    }
    this.decision(state.managerId, state.decisionId)
    const threadId = state.threadId
    if (!threadId) throw new Error('The background session is no longer available. Try again.')
    entry.answer = await this.turn(link, threadId, prompt, manager.effort)
    if (JSON.stringify(state.discussion.messages).length > 12000) {
      state.discussion.summary = await this.turn(
        link,
        threadId,
        'Summarize this decision background Q&A in a few lines for the manager. Preserve uncertainty. Do not answer the decision or take action.',
        manager.effort,
      ).catch(() => null)
    }
    entry.status = 'completed'
    entry.answeredAt = managerNow()
    this.save(state)
  }
  private async nativeConfig(link: EngineLink, cwd: string): Promise<Record<string, unknown>> {
    const read = await link.request('config/read', { cwd })
    const servers = isObject(read?.config?.mcp_servers) ? Object.keys(read.config.mcp_servers) : []
    return {
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.memories': false,
      'features.multi_agent': false,
      'features.image_generation': false,
      'features.request_permissions_tool': false,
      'features.shell_snapshot': false,
      'skills.include_instructions': false,
      web_search: 'disabled',
      mcp_servers: Object.fromEntries(servers.map((name) => [name, { enabled: false }])),
    }
  }
  private async turn(
    link: EngineLink,
    threadId: string,
    prompt: string,
    effort: string | null,
  ): Promise<string> {
    if (link.closed) throw new Error('Background connection closed. Try again.')
    return new Promise<string>((resolve, reject) => {
      let turnId: string | null = null
      let settled = false
      const done = (error: Error | null, answer = '') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unlisten()
        unclose()
        this.activeTurns.delete(threadId)
        error ? reject(error) : resolve(answer)
      }
      const unlisten = link.onNotification((method, params) => {
        if (method !== 'turn/completed' || params.threadId !== threadId) return
        const turn = params.turn
        if (turnId && turn?.id !== turnId) return
        if (turn?.status !== 'completed')
          return done(new Error('The background answer did not complete. Try again.'))
        const answer = lastAnswer(turn)
        if (answer !== null) done(null, answer)
        else
          void link.request('thread/read', { threadId, includeTurns: true }).then(
            (read) => {
              const found = read?.thread?.turns?.find((item: { id: string }) => item.id === turn.id)
              done(null, lastAnswer(found) ?? '')
            },
            (error) => done(error),
          )
      })
      const unclose = link.onClose(() =>
        done(new Error('Background connection closed. Try again.')),
      )
      const timer = setTimeout(() => {
        if (turnId) void link.request('turn/interrupt', { threadId, turnId }).catch(() => {})
        done(new Error('The background answer timed out. Try again.'))
      }, 180000)
      void link
        .request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          ...(effort ? { effort } : {}),
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
        })
        .then(
          (result) => {
            turnId = result?.turn?.id ?? null
            if (turnId && (this.closed || this.retired.has(threadId))) {
              void link.request('turn/interrupt', { threadId, turnId }).catch(() => {})
              done(new Error('The background session was closed.'))
              return
            }
            if (turnId && !settled) this.activeTurns.set(threadId, turnId)
          },
          (error) => done(error),
        )
    })
  }
  async release(state: QuestionState, link: EngineLink): Promise<void> {
    if (!state.threadId) return
    const id = state.threadId
    state.threadId = null
    const current = this.owner.store.question(state.managerId, state.decisionId)
    if (current?.threadId === id) {
      current.threadId = null
      this.owner.store.saveQuestion(current)
    }
    await this.disposeThread(id, link)
  }
  private async disposeThread(id: string, link: EngineLink): Promise<void> {
    this.retired.add(id)
    const turnId = this.activeTurns.get(id)
    if (turnId) await link.request('turn/interrupt', { threadId: id, turnId }).catch(() => {})
    await link.request('thread/unsubscribe', { threadId: id }).catch(() => {})
  }
  releaseClosed(managerId: string): void {
    const manager = this.owner.store.manager(managerId)
    if (!manager) return
    for (const state of this.owner.store.questions(managerId)) {
      const id = state.threadId
      if (
        !id ||
        this.releasing.has(id) ||
        (manager.status === 'active' && this.jobs.has(`${managerId}/${state.decisionId}`))
      )
        continue
      const decision = (() => {
        try {
          return this.owner.posts.get(managerId, state.decisionId)
        } catch {
          return null
        }
      })()
      if (manager.status === 'active' && decision?.revision === state.revision) continue
      this.releasing.add(id)
      state.threadId = null
      this.owner.store.saveQuestion(state)
      void this.link(manager)
        .then((link) => this.disposeThread(id, link))
        .catch((error) => {
          this.owner.tree.host.log(`释放旁问失败：${String(error)}`)
        })
        .finally(() => this.releasing.delete(id))
    }
  }
  forward(managerId: string, id: ManagerPostId): { queued: boolean } {
    const decision = this.decision(managerId, id)
    const state = this.owner.store.question(managerId, id)
    if (!state || state.discussion.messages.some((entry) => entry.status === 'running'))
      throw new ManagerError(
        'invalidManager',
        'Wait for a completed background conversation before forwarding.',
      )
    if (state.discussion.forwarded === state.discussion.messages.length) return { queued: false }
    this.owner.store.transaction(() => {
      this.owner.store.enqueue(
        managerId,
        forwardedManagerQuestion(id, decision.title, state.discussion),
      )
      state.discussion.forwarded = state.discussion.messages.length
      this.owner.store.saveQuestion(state)
    })
    this.owner.changed(managerId)
    this.owner.kick(managerId)
    return { queued: true }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const pending of this.links.values()) {
      const link = await pending.catch(() => null)
      if (!link) continue
      await Promise.allSettled(
        this.owner.store
          .questions()
          .filter((state) => this.owner.store.manager(state.managerId)?.harness === link.harness)
          .map((state) => this.release(state, link)),
      )
      link.close()
    }
    await Promise.allSettled(this.jobs.values())
  }
}
