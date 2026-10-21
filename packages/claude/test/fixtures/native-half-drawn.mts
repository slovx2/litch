// 一份“Claude 桌面端跑到一半时被 Litch 画了”的原生记录，照本机一个真实会话（2.1.304 写的）的行和字段做的，
// 话、路径、标识都换掉了。原来的会话里 Litch 在两个时刻去画：桌面端刚写下用户那句话（助手 30 秒后才开口）、
// 助手调了工具还没等到结果。旧的画法把前者画成一个 0 毫秒就完成的回合，后者画成一个没有用户消息、
// 以助手消息的号为标识的半截回合，工具调用记成失败，而且以后不改。
//
// 各段按时间先后排：before 是早就跑完的一轮，asked 是桌面端刚写下的那句话（加上排队、附件这些行），
// started 是助手想了想、调了一个命令，finished 是命令的结果和最后的回答。

/** 原生记录的会话号与工作目录 */
export interface HalfDrawnScene {
  sessionId: string
  cwd: string
}

let clock = Date.parse('2026-10-21T07:00:00.000Z')
const stamp = () => new Date((clock += 1000)).toISOString()

const usage = (input: number, output: number) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 1753,
  cache_read_input_tokens: input,
  output_tokens: output,
  output_tokens_details: { thinking_tokens: 120 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 1753, ephemeral_5m_input_tokens: 0 },
})

function common(scene: HalfDrawnScene) {
  return {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'claude-desktop',
    cwd: scene.cwd,
    sessionId: scene.sessionId,
    version: '2.1.304',
    gitBranch: 'main',
  }
}

function human(scene: HalfDrawnScene, uuid: string, parentUuid: string | null, text: string) {
  return {
    parentUuid,
    promptId: `prompt-${uuid}`,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp: stamp(),
    permissionMode: 'bypassPermissions',
    origin: { kind: 'human' },
    promptSource: 'sdk',
    turnOrigin: 'human',
    ...common(scene),
  }
}

function assistant(
  scene: HalfDrawnScene,
  uuid: string,
  parentUuid: string,
  messageId: string,
  stop: string,
  content: unknown[],
  used: ReturnType<typeof usage>,
) {
  return {
    parentUuid,
    message: {
      model: 'claude-opus-5-5',
      id: messageId,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: used,
    },
    requestId: `req-${messageId}`,
    type: 'assistant',
    uuid,
    timestamp: stamp(),
    effort: 'high',
    perTurnEffort: 'high',
    requestedModel: 'claude-opus-5-5',
    ...common(scene),
  }
}

function toolResult(
  scene: HalfDrawnScene,
  uuid: string,
  parentUuid: string,
  toolUseId: string,
  text: string,
) {
  return {
    parentUuid,
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text }] }],
    },
    uuid,
    timestamp: stamp(),
    toolUseResult: [{ type: 'text', text }],
    sourceToolAssistantUUID: parentUuid,
    permissionDecision: { decision: 'accept', source: 'config', reasonType: 'mode' },
    ...common(scene),
  }
}

function stopHook(scene: HalfDrawnScene, uuid: string, parentUuid: string) {
  return {
    parentUuid,
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 1,
    hookInfos: [],
    hookErrors: [],
    preventedContinuation: false,
    stopReason: '',
    hasOutput: false,
    level: 'suggestion',
    uuid,
    timestamp: stamp(),
    ...common(scene),
  }
}

const jsonl = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

export const HALF_DRAWN = {
  /** 早就跑完的一轮 */
  before: (scene: HalfDrawnScene) =>
    jsonl([
      human(scene, 'p0', null, '先看看这几个 PR 的状态'),
      assistant(
        scene,
        'p0a',
        'p0',
        'msg_p0',
        'end_turn',
        [{ type: 'text', text: '都看过了' }],
        usage(120_000, 300),
      ),
      stopHook(scene, 'p0h', 'p0a'),
    ]),
  /** 桌面端刚写下用户那句话：助手还没开口 */
  asked: (scene: HalfDrawnScene) =>
    jsonl([
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: stamp(),
        sessionId: scene.sessionId,
        content: '规则先不变，缓存只留三天',
      },
      {
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: stamp(),
        sessionId: scene.sessionId,
      },
      human(scene, 'u1', 'p0h', '规则先不变，缓存只留三天'),
      {
        parentUuid: 'u1',
        attachment: { type: 'total_tokens_reminder' },
        type: 'attachment',
        uuid: 'u1x',
        timestamp: stamp(),
        rendered: [{ content: '<system-reminder>\n内部提醒\n</system-reminder>' }],
        renderedRole: 'system',
        ...common(scene),
      },
      { type: 'api-request', id: 'req-1', sessionId: scene.sessionId, timestamp: stamp() },
    ]),
  /** 助手想了想、调了一个命令，结果还没回来 */
  started: (scene: HalfDrawnScene) =>
    jsonl([
      assistant(
        scene,
        'a1',
        'u1x',
        'msg_1',
        'tool_use',
        [{ type: 'thinking', thinking: '先跑一遍测试', signature: 'x' }],
        usage(130_000, 900),
      ),
      assistant(
        scene,
        'a2',
        'a1',
        'msg_1',
        'tool_use',
        [{ type: 'tool_use', id: 'toolu_half', name: 'Bash', input: { command: 'npm test' } }],
        usage(130_000, 900),
      ),
    ]),
  /** 命令的结果和最后的回答 */
  finished: (scene: HalfDrawnScene) =>
    jsonl([
      toolResult(scene, 'r1', 'a2', 'toolu_half', '42 passed'),
      assistant(
        scene,
        'a3',
        'r1',
        'msg_2',
        'end_turn',
        [{ type: 'text', text: '测试都过了，规则没动' }],
        usage(131_000, 200),
      ),
      stopHook(scene, 'a3h', 'a3'),
    ]),
}
