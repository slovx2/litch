// 测试用的协议数据。只填测试关心的字段，其余给合理的默认值。
import type { Project, Thread, ThreadItem, Turn } from '../../protocol/src/index.mjs'

export function thread(fields: Partial<Thread> & { id: string }): Thread {
  return {
    environments: null,
    extra: null,
    sessionId: fields.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'default',
    modelProvider: 'test',
    model: null,
    reasoningEffort: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    recencyAt: null,
    status: { type: 'notLoaded' },
    path: null,
    cwd: '/work/app',
    cliVersion: '0.0.0',
    originator: null,
    source: 'cli',
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
    ...fields,
  } as Thread
}

export function turn(id: string, items: ThreadItem[], fields: Partial<Turn> = {}): Turn {
  return {
    id,
    rootTurnId: null,
    items,
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1_700_000_100,
    completedAt: 1_700_000_130,
    durationMs: 30_000,
    ...fields,
  }
}

export function project(id: string, name: string, root: string, position = 0): Project {
  return {
    id,
    name,
    roots: [{ path: root }],
    metadata: {},
    position,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    recencyAt: null,
  }
}

export const userText = (id: string, text: string): ThreadItem => ({
  type: 'userMessage',
  id,
  clientId: null,
  content: [{ type: 'text', text, text_elements: [] }],
})

export const agentText = (
  id: string,
  text: string,
  phase: 'commentary' | 'final_answer' | null = null,
): ThreadItem => ({
  type: 'agentMessage',
  id,
  text,
  phase,
  memoryCitation: null,
  delivery: null,
  questions: null,
})
