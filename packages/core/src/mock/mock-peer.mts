// 模拟核心里的会话间消息（peerMessages 扩展，Claude 的本机收件箱）：
// 对话里说“别的会话”（英文 other session）：模型先列出本机的会话、给“终端里的 Claude”发一条消息，回一句就停下；
// 过一会儿 Claude 桌面端的一个会话（跳过确认档）发来一条消息，harness 自己开一轮（来历 peer，开头是那条消息）处理它：
// 先照真模型的做法往信封里的收件箱地址回一封（入口认出了收件方，条目上写它的名字），再回答。
// 条目的显示标识照真的核心写成“回合:协议条目标识”。
import type { SessionOp } from '../channel/protocol.mjs'
import type {
  ItemView,
  OutgoingMessage,
  SessionSummary,
  SessionView,
  ToolCallItem,
} from '../model.mjs'
import type { SampleLang } from './sample-text.mjs'

const STARTS = /别的会话|other sessions?/i

/** 发来消息的 Claude 桌面端会话：会话号、收件箱地址 */
const PEER_SESSION = 'local_6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const PEER_ADDRESS = 'uds:/tmp/cc-socks/41237.sock'

/** 发出去之后多久收到对面的消息（按模拟的时钟） */
export const PEER_REPLY_MS = 4000

const TEXT = {
  'zh-CN': {
    list: 'This session is workspace-3f [a1b2c3]\n\nPeer sessions (2):\n  终端里的 Claude [9d8e7f]  ·  interactive  ·  idle\n  修 CI [5c4b3a]  ·  Claude Desktop session  ·  busy',
    sendTo: '终端里的 Claude',
    sent: '已经把要看的日志范围发给“终端里的 Claude”了，它回话时会出现在这里。',
    from: '修 CI',
    peerText:
      '我这边在修 CI，需要确认一下：`packages/core` 里的 diff 解析最近改过吗？如果改过，请告诉我是哪个提交，我好对照失败的用例。',
    answer:
      '改过：`packages/core/src/text/diff.mts` 在 49df7c0 里改了块头的解析（空白行不再丢）。失败的用例如果断言了旧的块头，换成 `@@ -3,3 +3,2 @@` 这样的就行。',
  },
  en: {
    list: 'This session is workspace-3f [a1b2c3]\n\nPeer sessions (2):\n  terminal-claude [9d8e7f]  ·  interactive  ·  idle\n  fix-ci [5c4b3a]  ·  Claude Desktop session  ·  busy',
    sendTo: 'terminal-claude',
    sent: 'I sent the log range to terminal-claude; its reply will show up here.',
    from: 'fix-ci',
    peerText:
      'I am fixing CI here and need to check: did the diff parser in `packages/core` change recently? If so, which commit, so I can compare it with the failing tests.',
    answer:
      'Yes: `packages/core/src/text/diff.mts` changed hunk-header parsing in 49df7c0 (blank lines are kept now). If a failing test asserts the old header, switch it to one like `@@ -3,3 +3,2 @@`.',
  },
} as const

export interface MockPeerHost {
  lang: SampleLang
  now(): number
  setTimer(run: () => void, ms: number): () => void
  updateSummary(deviceId: string, sessionId: string, patch: Partial<SessionSummary>): void
  apply(view: SessionView, ops: SessionOp[]): void
  /** 在回合里流出一段回答，流完回合结束 */
  reply(view: SessionView, turnId: string, text: string): void
  nextId(prefix: string): string
}

export interface MockPeer {
  /** 这条消息是不是会话间消息这一出：是的话由这里接着演，返回 true */
  claim(view: SessionView, turnId: string, message: OutgoingMessage): boolean
}

export function createMockPeer(host: MockPeerHost): MockPeer {
  const text = TEXT[host.lang]
  const tool = (turnId: string, name: string, input: string, output: string): ToolCallItem => ({
    id: `${turnId}:${host.nextId('peer-tool-')}`,
    kind: 'toolCall',
    source: 'claude-code',
    tool: name,
    input: input ? [{ kind: 'text', text: input }] : [],
    output: [{ kind: 'text', text: output }],
    error: null,
    durationMs: 120,
    status: 'completed',
  })

  /** 对面发来的消息：harness 自己开一轮，开头是那条带来源的消息 */
  const arrive = (view: SessionView) => {
    const turnId = host.nextId('peer')
    const message: ItemView = {
      id: `${turnId}:${host.nextId('peer-msg-')}`,
      kind: 'userMessage',
      text: text.peerText,
      attachments: [],
      peer: { name: text.from, session: PEER_SESSION, bypass: true },
    }
    host.apply(view, [
      {
        op: 'turn.add',
        turn: {
          id: turnId,
          status: 'running',
          itemIds: [],
          startedAt: host.now(),
          durationMs: null,
          error: null,
          origin: 'peer',
        },
      },
      { op: 'item.add', turnId, item: message },
      {
        op: 'item.add',
        turnId,
        item: {
          ...tool(
            turnId,
            `SendMessage ${text.from}`,
            JSON.stringify({ to: PEER_ADDRESS, message: '…' }, null, 2),
            '{"success":true}',
          ),
          peer: { name: text.from, session: PEER_SESSION, bypass: false },
        },
      },
    ])
    host.updateSummary(view.deviceId, view.sessionId, { status: 'running', updatedAt: host.now() })
    host.reply(view, turnId, text.answer)
  }

  return {
    claim(view, turnId, message) {
      if (!STARTS.test(message.text)) return false
      host.apply(view, [
        { op: 'item.add', turnId, item: tool(turnId, 'ListAgents', '{}', text.list) },
        {
          op: 'item.add',
          turnId,
          item: tool(
            turnId,
            `SendMessage ${text.sendTo}`,
            JSON.stringify({ to: text.sendTo, message: '…' }, null, 2),
            '{"success":true}',
          ),
        },
      ])
      host.reply(view, turnId, text.sent)
      host.setTimer(() => arrive(view), PEER_REPLY_MS)
      return true
    },
  }
}
