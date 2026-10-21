import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { getSessionMessages, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { lostToolCallsNotice, NativeToolIntents } from '../src/native-tool-intents.mjs'
import { SessionStore } from '../src/store.mjs'
import { ToolIntentTranscripts, TranscriptTail } from '../src/transcript-tail.mjs'
import type { NativeToolIntent, RuntimeTurnContext } from '../src/types.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 原生工具执行之前，PreToolUse 钩子把这次调用记进入口的库就放行，不等 CLI 把它写进会话记录
// （native-runtime.mts 的 buildOptions）；有没有进会话记录挪到回合开始前、结束后核对（native-tool-intents.mts），
// 没进、写它的 CLI 又不在了的，下一回合告诉模型。
// INTENT-001、INTENT-002 用真的原生运行时，只把 SDK 换成照着念的；TAIL-* 是怎么读会话记录：
// 每份记录只读新增的部分，数的是和机器快慢无关的量（读了多少字节、解析了多少行带着会话 ID 的 JSON）。
// SETTLE-* 是核对本身；INTENT-003、INTENT-004 用真的 CLI 加假模型。

const require = createRequire(import.meta.url)
const fsp = require('node:fs/promises') as typeof import('node:fs/promises')

/** 数被测代码从 dir 下面的文件里读了多少字节、解析了多少行带着 sessionId 的 JSON */
async function meter(dir: string, sessionId: string) {
  const counts = { bytes: 0, lines: 0 }
  const original = { readFile: fsp.readFile, open: fsp.open, parse: JSON.parse }
  const probe = await open(fileURLToPath(import.meta.url), 'r')
  const handleProto = Object.getPrototypeOf(probe) as { read: (...args: any[]) => any }
  await probe.close()
  const read = handleProto.read
  const handles = new WeakSet<object>()
  const under = (path: unknown) => String(path).startsWith(dir)
  fsp.readFile = async function (this: unknown, path: any, ...rest: any[]) {
    const data = await (original.readFile as any).call(this, path, ...rest)
    if (under(path)) counts.bytes += Buffer.byteLength(data)
    return data
  } as typeof fsp.readFile
  fsp.open = async function (this: unknown, path: any, ...rest: any[]) {
    const handle = await (original.open as any).call(this, path, ...rest)
    if (under(path)) handles.add(handle)
    return handle
  } as typeof fsp.open
  handleProto.read = async function (this: object, ...args: any[]) {
    const result = await read.apply(this, args)
    if (handles.has(this)) counts.bytes += result.bytesRead
    return result
  }
  JSON.parse = ((text: string, reviver?: any) => {
    if (typeof text === 'string' && text.includes(sessionId)) counts.lines++
    return original.parse(text, reviver)
  }) as typeof JSON.parse
  syncBuiltinESMExports()
  return {
    counts,
    stop() {
      fsp.readFile = original.readFile
      fsp.open = original.open
      handleProto.read = read
      JSON.parse = original.parse
      syncBuiltinESMExports()
    },
  }
}

/** 照 CLI 2.1.282 的样子写会话记录：每行一个对象，接成一串（parentUuid 是上一行的 uuid） */
class FakeTranscript {
  private parent: string | null = null
  readonly path: string
  private readonly sessionId: string
  private readonly cwd: string
  private readonly agentId: string | undefined
  constructor(path: string, sessionId: string, cwd: string, agentId?: string) {
    this.path = path
    this.sessionId = sessionId
    this.cwd = cwd
    this.agentId = agentId
  }
  /** 一行（含换行）；uuid 现在定，接在上一行后面 */
  line(fields: Record<string, unknown>): string {
    const uuid = randomUUID()
    const entry = {
      parentUuid: this.parent,
      isSidechain: this.agentId !== undefined,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: '2.1.282',
      gitBranch: '',
      ...fields,
      uuid,
      timestamp: new Date().toISOString(),
    }
    this.parent = uuid
    return `${JSON.stringify(entry)}\n`
  }
  /** 一条助手消息里的一个内容块（一行），用量照 CLI 写那一刻的 */
  assistant(messageId: string, block: Record<string, unknown>, outputTokens: number): string {
    return this.line({
      type: 'assistant',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [block],
        stop_reason: block.type === 'tool_use' ? 'tool_use' : null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 7,
        },
      },
      requestId: `req_${messageId}`,
    })
  }
  /** 工具的结果：CLI 在消息里和 toolUseResult 里各放一份 */
  result(toolUseId: string, output: string): string {
    return this.line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }],
      },
      toolUseResult: { stdout: output, stderr: '', interrupted: false },
    })
  }
  append(text: string): void {
    appendFileSync(this.path, text)
  }
}

const baseContext: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
  prompt: '把这些文件挨个看一遍',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
  goalTools: true,
  trackGoalTools: true,
}

type PreToolUseHook = (
  event: Record<string, unknown>,
  toolUseId: string,
  options: { signal: AbortSignal },
) => Promise<Record<string, any>>

/** 像 CLI 一样把注册的 PreToolUse 钩子挨个调一遍，回第一个拒绝的理由（都放行时是 null） */
async function preToolUse(
  options: Record<string, any>,
  event: Record<string, unknown>,
  toolUseId: string,
): Promise<string | null> {
  for (const matcher of options.hooks.PreToolUse as Array<{ hooks: PreToolUseHook[] }>)
    for (const hook of matcher.hooks) {
      const output = await hook(event, toolUseId, { signal: new AbortController().signal })
      if (output?.hookSpecificOutput?.permissionDecision === 'deny')
        return String(output.hookSpecificOutput.permissionDecisionReason)
    }
  return null
}

/** 用例的目录：CLAUDE_CONFIG_DIR 和工作目录，会话记录放在 SDK 找得到的地方 */
async function sandbox(
  run: (dirs: {
    config: string
    projects: string
    cwd: string
    transcript: string
    sessionId: string
  }) => Promise<void>,
) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'tool-intent-')))
  const previous = process.env.CLAUDE_CONFIG_DIR
  const config = join(root, 'claude')
  const cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  const projects = join(config, 'projects')
  const project = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const sessionId = randomUUID()
  process.env.CLAUDE_CONFIG_DIR = config
  try {
    await run({ config, projects, cwd, transcript: join(project, `${sessionId}.jsonl`), sessionId })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
const CALLS = 150
/** 入口告诉模型有调用结果未知时那段话的开头（native-tool-intents.mts） */
const LOST_NOTICE = 'These tool calls from an earlier turn were started'

test('INTENT-001：一个回合里一百多次工具调用，钩子都当场放行、记下意图，不读会话记录', {
  timeout: 120_000,
}, async () => {
  await sandbox(async ({ projects, cwd, transcript, sessionId }) => {
    const main = new FakeTranscript(transcript, sessionId, cwd)
    main.append(main.line({ type: 'user', message: { role: 'user', content: baseContext.prompt } }))
    const childId = 'a0123456789abcdef'
    const calls: Array<{ id: string; agent: string | null; input: Record<string, unknown> }> = []
    const denied: string[] = []
    let slowest = 0
    const runtime = new NativeClaudeRuntime()
    Reflect.set(runtime, 'sdk', {
      getSessionMessages,
      getSubagentMessages,
      query: ({ options }: { options: Record<string, any> }) =>
        (async function* () {
          for (let index = 0; index < CALLS; index++) {
            const agent = index % 10 === 3 ? childId : null
            // 有的消息里是并行的两次调用；会话记录一行都不写（CLI 还没攒够一批）
            const ids = index % 10 === 5 ? [toolId(), toolId()] : [toolId()]
            const input = { file_path: join(cwd, `f${index}.txt`) }
            const decisions = await Promise.all(
              ids.map(async (id) => {
                const started = performance.now()
                const reason = await preToolUse(
                  options,
                  {
                    hook_event_name: 'PreToolUse',
                    session_id: sessionId,
                    transcript_path: transcript,
                    cwd,
                    tool_name: 'Read',
                    tool_input: input,
                    tool_use_id: id,
                    ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}),
                  },
                  id,
                )
                slowest = Math.max(slowest, performance.now() - started)
                return reason
              }),
            )
            ids.forEach((id, k) => {
              if (decisions[k]) denied.push(`${index} ${id}: ${decisions[k]}`)
              calls.push({ id, agent, input })
            })
          }
          yield { type: 'result', subtype: 'success', result: '看完了。', session_id: sessionId }
        })(),
    })
    const recorded: NativeToolIntent[] = []
    const reserved: Array<[string, string, Record<string, unknown>]> = []
    const metered = await meter(projects, sessionId)
    try {
      await runtime.runTurn(
        { ...baseContext, cwd },
        {
          onEvent: async () => {},
          onPermissionRequest: async () => ({ decision: 'accept' }),
          onUserInputRequest: async () => ({ answers: {} }),
          onNativeToolCall: (intent) => {
            recorded.push(intent)
          },
          onNativeToolIntent: (callId, name, args) => {
            reserved.push([callId, name, args])
          },
        },
      )
    } finally {
      metered.stop()
    }
    assert.deepEqual(denied, [], '会话记录里还没有这次调用，钩子也该放行')
    assert.deepEqual(
      recorded,
      calls.map((call) => ({
        callId: call.id,
        tool: 'Read',
        input: call.input,
        sessionKey: baseContext.threadId,
        transcriptPath: transcript,
        agentId: call.agent,
      })),
    )
    // 有目标时照旧登记目标用的工具意图（GOAL-002 恢复时靠它挡住自动续跑）
    assert.deepEqual(
      reserved,
      calls.map((call) => [call.id, 'Read', call.input]),
    )
    assert.deepEqual(metered.counts, { bytes: 0, lines: 0 }, '钩子不该去读会话记录')
    assert.ok(slowest < 1_000, `一次钩子最慢 ${slowest.toFixed(0)} 毫秒，不该再等会话记录`)
  })
})

test('INTENT-002：意图记不下（回合已经结束）、事件里没有会话记录的路径、回合已取消时拒绝执行', {
  timeout: 60_000,
}, async () => {
  await sandbox(async ({ cwd, transcript, sessionId }) => {
    new FakeTranscript(transcript, sessionId, cwd).append('')
    const [ok, refused, pathless] = [toolId(), toolId(), toolId()]
    const runtime = new NativeClaudeRuntime()
    let decisions: Array<string | null> = []
    const event = (id: string, path: unknown = transcript) => ({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      transcript_path: path,
      cwd,
      tool_name: 'Read',
      tool_input: { file_path: cwd },
      tool_use_id: id,
    })
    Reflect.set(runtime, 'sdk', {
      getSessionMessages,
      getSubagentMessages,
      query: ({ options }: { options: Record<string, any> }) =>
        (async function* () {
          decisions = [
            await preToolUse(options, event(ok), ok),
            await preToolUse(options, event(refused), refused),
            await preToolUse(options, event(pathless, null), pathless),
          ]
          yield { type: 'result', subtype: 'success', result: 'done', session_id: sessionId }
        })(),
    })
    const recorded: string[] = []
    await runtime.runTurn(
      { ...baseContext, cwd, trackGoalTools: false },
      {
        onEvent: async () => {},
        onPermissionRequest: async () => ({ decision: 'accept' }),
        onUserInputRequest: async () => ({ answers: {} }),
        onNativeToolCall: (intent) => {
          if (intent.callId === refused) throw new Error('Turn 已结束，不能执行原生工具')
          recorded.push(intent.callId)
        },
      },
    )
    const unrecorded = '原生工具意图未能记下或回合已取消，禁止执行。'
    assert.deepEqual(decisions, [null, unrecorded, unrecorded])
    assert.deepEqual(recorded, [ok])
  })
})

test('INTENT-005：新会话的记录文件还没写出来时钩子等它出现再放行，一直不出现就拒绝', {
  timeout: 60_000,
}, async () => {
  await sandbox(async ({ cwd, transcript, sessionId }) => {
    const [late, never] = [toolId(), toolId()]
    const runtime = new NativeClaudeRuntime()
    const timings: number[] = []
    let decisions: Array<string | null> = []
    const event = (id: string, path: string) => ({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      transcript_path: path,
      cwd,
      tool_name: 'Read',
      tool_input: { file_path: cwd },
      tool_use_id: id,
    })
    Reflect.set(runtime, 'sdk', {
      getSessionMessages,
      getSubagentMessages,
      query: ({ options }: { options: Record<string, any> }) =>
        (async function* () {
          const timed = async (id: string, path: string) => {
            const started = performance.now()
            const reason = await preToolUse(options, event(id, path), id)
            timings.push(performance.now() - started)
            return reason
          }
          // 像 CLI 第一次写那样，300 毫秒后文件才出现
          setTimeout(() => new FakeTranscript(transcript, sessionId, cwd).append(''), 300)
          decisions = [
            await timed(late, transcript),
            await timed(never, join(cwd, 'never-written.jsonl')),
          ]
          yield { type: 'result', subtype: 'success', result: 'done', session_id: sessionId }
        })(),
    })
    const recorded: string[] = []
    await runtime.runTurn(
      { ...baseContext, cwd, trackGoalTools: false },
      {
        onEvent: async () => {},
        onPermissionRequest: async () => ({ decision: 'accept' }),
        onUserInputRequest: async () => ({ answers: {} }),
        onNativeToolCall: (intent) => {
          recorded.push(intent.callId)
        },
      },
    )
    assert.deepEqual(decisions, [null, '原生工具意图未能记下或回合已取消，禁止执行。'])
    assert.deepEqual(recorded, [late], '文件一直没有的那次不记意图、不执行')
    assert.ok(timings[0]! >= 250, `等到文件出现才放行，实际 ${timings[0]!.toFixed(0)} 毫秒`)
    assert.ok(timings[1]! >= 2_900, `一直不出现时等满再拒，实际 ${timings[1]!.toFixed(0)} 毫秒`)
  })
})

// ---------- 一份会话记录怎么读：只读新增的部分，文件被改过时认得出来、从头再读 ----------

/** 临时目录里的一份会话记录 */
async function scratch(run: (file: FakeTranscript, dir: string) => Promise<void>) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'transcript-tail-')))
  try {
    await run(new FakeTranscript(join(dir, 's.jsonl'), randomUUID(), dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const useBlock = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: 'a' } })
const messageOf = (line: string) => JSON.parse(line).message
/** 像 CLI 撤掉一条消息那样：原地截到那一行的开头，再把它后面的行接回去（还是同一个文件） */
function removeLine(path: string, line: string): void {
  const content = readFileSync(path)
  const start = content.indexOf(line)
  assert.ok(start >= 0)
  const after = content.subarray(start + Buffer.byteLength(line))
  truncateSync(path, start)
  appendFileSync(path, after)
}

test('TAIL-001：没有换行的半行不算，写完了才认；只解析带 tool_use 块的行，读过的不再读', async () => {
  await scratch(async (file) => {
    file.append(file.line({ type: 'user', message: { role: 'user', content: '开始' } }))
    for (let index = 0; index < 5; index++)
      file.append(file.result(`toolu_old_${index}`, 'z'.repeat(20_000)))
    const tail = new TranscriptTail(file.path, false)
    const id = toolId()
    const line = file.assistant('msg_1', useBlock(id), 5)
    file.append(line.slice(0, 100))
    assert.equal(await tail.find(id), null)
    // 整行都在，只差换行
    file.append(line.slice(100, -1))
    assert.equal(await tail.find(id), null)
    assert.equal(tail.stats.linesParsed, 0, '工具结果的行和没写完的行都不解析')
    file.append('\n')
    assert.deepEqual(await tail.find(id), messageOf(line))
    assert.equal(tail.stats.linesParsed, 1)
    const size = statSync(file.path).size
    // 前面的整个读了一遍，没写完的那一行每次都从它的开头再读
    assert.ok(tail.stats.bytesRead < size + 3 * line.length + 3 * 1024, `${tail.stats.bytesRead}`)
    // 再问一次：只读记着的那一行和核对用的那一点
    const before = tail.stats.bytesRead
    assert.deepEqual(await tail.find(id), messageOf(line))
    assert.ok(tail.stats.bytesRead - before <= line.length + 1024)
    assert.equal(tail.stats.rescans, 0)
  })
})

test('TAIL-002：CLI 撤掉一条消息（原地截短、后面的行挪上来）之后，撤掉的不认，新写的照认', async (t) => {
  for (const after of ['只截短', '截短之后又写了更多']) {
    await t.test(after, async () => {
      await scratch(async (file) => {
        const [kept, removed, later] = [toolId(), toolId(), toolId()]
        const keptLine = file.assistant('msg_1', useBlock(kept), 3)
        const removedLine = file.assistant('msg_1', useBlock(removed), 3)
        file.append(keptLine + file.result(kept, 'ok') + removedLine)
        const tail = new TranscriptTail(file.path, false)
        // 认 kept 的时候 removed 那一行也看过、记下了位置
        assert.deepEqual(await tail.find(kept), messageOf(keptLine))
        removeLine(file.path, removedLine)
        const laterLine = file.assistant('msg_2', useBlock(later), 9)
        if (after !== '只截短')
          file.append(file.result(kept, 'r'.repeat(removedLine.length)) + laterLine)
        assert.equal(await tail.find(removed), null, '撤掉的那次调用不能再认')
        assert.ok(tail.stats.rescans >= 1)
        assert.deepEqual(await tail.find(kept), messageOf(keptLine))
        if (after === '只截短') file.append(laterLine)
        assert.deepEqual(await tail.find(later), messageOf(laterLine))
      })
    })
  }
})

test('TAIL-003：文件被原地整个重写、或者写到别处再改名换掉，都认得出来，从头再读', async (t) => {
  for (const how of ['原地重写', '改名换掉']) {
    await t.test(how, async () => {
      await scratch(async (file, dir) => {
        const [first, second, third] = [toolId(), toolId(), toolId()]
        const lines = [
          file.line({ type: 'user', message: { role: 'user', content: '开始' } }),
          file.assistant('msg_1', useBlock(first), 2),
          file.result(first, 'a'.repeat(3000)),
          file.assistant('msg_2', useBlock(second), 2),
        ]
        file.append(lines.join(''))
        const tail = new TranscriptTail(file.path, false)
        assert.deepEqual(await tail.find(second), messageOf(lines[3] ?? ''))
        // 去掉第一次调用的那两行，后面多出一次调用：比原来长，读过的那一截已经不是原样
        const thirdLine = file.assistant('msg_3', useBlock(third), 2)
        const rewritten = [lines[0], lines[3], file.result(second, 'b'.repeat(5000)), thirdLine]
        if (how === '原地重写') writeFileSync(file.path, rewritten.join(''))
        else {
          writeFileSync(join(dir, 's.jsonl.compact.tmp'), rewritten.join(''))
          renameSync(join(dir, 's.jsonl.compact.tmp'), file.path)
        }
        assert.deepEqual(await tail.find(third), messageOf(thirdLine))
        assert.equal(tail.stats.rescans, 1)
        assert.equal(await tail.find(first), null)
        assert.deepEqual(await tail.find(second), messageOf(lines[3] ?? ''))
      })
    })
  }
})

/** SDK 读这份记录交出来的（记录要放在 SDK 找得到的地方） */
async function getSessionMessagesAt(file: FakeTranscript): Promise<any[]> {
  const sessionId = JSON.parse(readFileSync(file.path, 'utf8').split('\n')[0] ?? '').sessionId
  const config = join(file.path, '..', 'claude')
  const cwd = join(file.path, '..')
  const project = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${sessionId}.jsonl`), readFileSync(file.path))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  try {
    return await getSessionMessages(sessionId, { dir: cwd })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
}

test('TAIL-004：同一次调用出现在几行里时认第一行，和 SDK 一样；几次一起问各得各的', async () => {
  await scratch(async (file) => {
    const [twice, other] = [toolId(), toolId()]
    const firstLine = file.assistant('msg_1', useBlock(twice), 1)
    const otherLine = file.assistant('msg_1', useBlock(other), 1)
    file.append(firstLine + otherLine + file.assistant('msg_1', useBlock(twice), 40))
    const tail = new TranscriptTail(file.path, false)
    const [a, b] = await Promise.all([tail.find(other), tail.find(twice)])
    assert.deepEqual([a, b], [messageOf(otherLine), messageOf(firstLine)])
    const sdkList = await getSessionMessagesAt(file)
    const sdkFirst = sdkList.find((entry: any) => entry.message.content?.[0]?.id === twice)
    assert.deepEqual(b, sdkFirst?.message)
  })
})

test('TAIL-005：子代理的调用到会话目录的 subagents/ 下面找（工作流的再套一层），主会话里 isSidechain 的行不认', async () => {
  await scratch(async (_file, dir) => {
    const sessionId = randomUUID()
    const main = new FakeTranscript(join(dir, `${sessionId}.jsonl`), sessionId, dir)
    const subagents = join(dir, sessionId, 'subagents')
    mkdirSync(join(subagents, 'workflows', 'run-9'), { recursive: true })
    const direct = new FakeTranscript(join(subagents, 'agent-a1.jsonl'), sessionId, dir, 'a1')
    const nested = new FakeTranscript(
      join(subagents, 'workflows', 'run-9', 'agent-w1.jsonl'),
      sessionId,
      dir,
      'w1',
    )
    const [mainCall, sideCall, directCall, nestedCall] = [toolId(), toolId(), toolId(), toolId()]
    const mainLine = main.assistant('msg_m', useBlock(mainCall), 1)
    main.append(
      mainLine +
        main.line({
          type: 'assistant',
          isSidechain: true,
          message: { id: 'msg_s', role: 'assistant', content: [useBlock(sideCall)] },
        }),
    )
    const directLine = direct.assistant('msg_d', useBlock(directCall), 1)
    const nestedLine = nested.assistant('msg_n', useBlock(nestedCall), 1)
    direct.append(directLine)
    const transcripts = new ToolIntentTranscripts()
    const event = (agent?: string) => ({
      transcript_path: main.path,
      session_id: sessionId,
      ...(agent ? { agent_id: agent } : {}),
    })
    assert.deepEqual(await transcripts.find(event(), mainCall), messageOf(mainLine))
    assert.equal(await transcripts.find(event(), sideCall), null)
    assert.equal(
      await transcripts.find(event(), directCall),
      null,
      '主会话的记录里没有子代理的调用',
    )
    assert.deepEqual(await transcripts.find(event('a1'), directCall), messageOf(directLine))
    // 子代理的记录还没建出来时是 null，建出来之后照认
    assert.equal(await transcripts.find(event('w1'), nestedCall), null)
    nested.append(nestedLine)
    assert.deepEqual(await transcripts.find(event('w1'), nestedCall), messageOf(nestedLine))
    await assert.rejects(transcripts.find(event('../a1'), directCall))
    await assert.rejects(transcripts.find({ session_id: sessionId }, mainCall))
  })
})

test('TAIL-006：核对过之后、读新增部分之前文件被撤掉一行（错位了），读完再核对时认出来，下次从头读', async () => {
  await scratch(async (file) => {
    const [early, target] = [toolId(), toolId()]
    // 撤掉的那一行比要找的那一行长：错位之后要找的那一行整个落在已经处理过的位置之前
    const earlyLine = file.assistant(
      'msg_1',
      { ...useBlock(early), input: { pad: 'p'.repeat(3000) } },
      1,
    )
    file.append(file.line({ type: 'user', message: { role: 'user', content: '开始' } }) + earlyLine)
    file.append(file.result(early, 'r'.repeat(2000)))
    const tail = new TranscriptTail(file.path, false)
    assert.deepEqual(await tail.find(early), messageOf(earlyLine))
    const targetLine = file.assistant('msg_2', useBlock(target), 1)
    file.append(targetLine + file.result(target, 'f'.repeat(4000)))
    // CLI 正好在核对之后撤掉了前面那一行
    const intact = Reflect.get(tail, 'intact') as (...args: unknown[]) => Promise<boolean>
    Reflect.set(tail, 'intact', async function (this: unknown, ...args: unknown[]) {
      const result = await intact.apply(this, args)
      Reflect.set(tail, 'intact', intact)
      removeLine(file.path, earlyLine)
      return result
    })
    assert.equal(await tail.find(target), null)
    assert.equal(tail.stats.rescans, 1)
    assert.deepEqual(await tail.find(target), messageOf(targetLine))
    assert.equal(await tail.find(early), null)
  })
})

// ---------- 端到端：真的 CLI（CHA_CLAUDE_CLI 指的隔离副本）加回环上的假模型 ----------

test('INTENT-003：真的 CLI 里接连调工具（含并行的两次、前台子代理里的调用），都照常执行，没有被拒', {
  timeout: 180_000,
}, async () => {
  const home = realpathSync(await mkdtemp(join(tmpdir(), 'tool-intent-e2e-')))
  writeFileSync(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const STEPS = 8
  const model = new MockLLM()
  const toolResults = (request: ModelRequest) =>
    ((request.messages ?? []) as Array<Record<string, any>>).flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block: any) => block.type === 'tool_result')
        : [],
    )
  // 主会话和子代理的请求可能交错，按请求内容应答
  model.fallback = (request) => {
    const first = JSON.stringify(request.messages?.[0]?.content ?? '')
    const done = toolResults(request).length
    if (first.includes('INTENT_CHILD'))
      return done === 0
        ? [
            {
              type: 'tool_use',
              id: toolId(),
              name: 'Read',
              input: { file_path: join(home, 'a.txt') },
            },
          ]
        : [{ type: 'text', text: 'CHILD_DONE' }]
    if (!first.includes('INTENT_MAIN')) throw new Error('收到无法归属的模型请求')
    if (done === 0)
      return [
        { type: 'text', text: '先看两样' },
        { type: 'tool_use', id: toolId(), name: 'Read', input: { file_path: join(home, 'a.txt') } },
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Bash',
          input: { command: 'echo step-1', description: 'echo' },
        },
      ]
    if (done < 2 + STEPS)
      return [
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Bash',
          input: { command: `echo step-${done}`, description: 'echo' },
        },
      ]
    if (done === 2 + STEPS)
      return [
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Agent',
          input: {
            description: '读文件',
            prompt: 'INTENT_CHILD 读取 a.txt',
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
      ]
    return [{ type: 'text', text: 'MAIN_DONE' }]
  }
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'INTENT_MAIN 挨个调工具' }],
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    const requests = JSON.stringify(model.requests)
    assert.ok(!requests.includes('未能记下'), '有工具调用被钩子拒了')
    assert.deepEqual(model.unexpected, [])
    const read = (await client.request('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    const commands = read.turns
      .at(-1)
      .items.filter((item: any) => item.type === 'commandExecution')
      .map((item: any) => [item.status, item.aggregatedOutput.trim()])
    assert.deepEqual(
      commands,
      Array.from({ length: STEPS + 1 }, (_, index) => ['completed', `step-${index + 1}`]),
    )
    // 两次 Read（主会话的、子代理的）都真的读到了文件
    const reads = model.requests
      .flatMap(toolResults)
      .filter((block: any) => JSON.stringify(block.content).includes('probe-file-content: 42'))
    assert.ok(reads.length >= 2, '主会话和子代理的 Read 都该有结果')
    assert.ok(requests.includes('CHILD_DONE'), '子代理的结果交回了主会话')
    // 下一回合：CLI 早把这些调用写进了会话记录，不该告诉模型有调用结果未知；记下的意图都核对掉了
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'INTENT_MAIN 再来一轮' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    assert.ok(!JSON.stringify(model.requests.at(-1)).includes(LOST_NOTICE))
    const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
    try {
      // 第二回合自己的调用要到回合结束后核对，这里只看第一回合的
      const left = db
        .prepare('SELECT call_id FROM native_tool_intents WHERE turn_id=?')
        .all(turn.id)
      assert.deepEqual(left, [])
    } finally {
      db.close()
    }
    const log = readFileSync(join(home, 'adapter', 'debug.jsonl'), 'utf8')
    assert.ok(!log.includes('native.toolIntent.unrecorded'))
    assert.ok(!log.includes('native.toolIntent.lost'))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 放行执行了、还没进 CLI 会话记录的调用：CLI 一条回复里的工具调用是边流边执行的，这个块那一行要等同一条回复
// 后面的块流完才写。假模型在 tool_use 块后面停几秒再接一段字，Bash 的副作用发生时这一行一定还没写；
// 这时把 CLI 强杀（只杀 CLI，或者连入口一起），下一回合模型必须被告知这次调用发出过、结果未知。
for (const mode of ['cli', 'adapter'] as const)
  test(`INTENT-004：副作用之后、调用进会话记录之前强杀${mode === 'cli' ? ' CLI' : ' CLI 和入口'}，下一回合告诉模型这次调用结果未知`, {
    timeout: 120_000,
  }, async () => {
    const home = realpathSync(await mkdtemp(join(tmpdir(), 'tool-intent-lost-')))
    const target = join(home, 'effect.txt')
    const model = new MockLLM()
    const url = await model.start()
    let client = await ProtocolClient.start(home, url)
    const callId = 'toolu_lost_effect_01'
    try {
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: callId,
          name: 'Bash',
          input: {
            command: `printf X >> '${target}'; /bin/sleep 30`,
            description: 'effect',
            timeout: 60_000,
          },
          pauseAfterMs: 4_000,
        },
        { type: 'text', text: 'AFTER_TOOL' },
      ])
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'LOST_FIRST 跑一次命令' }],
      })
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && (await readFile(target, 'utf8').catch(() => '')) !== 'X')
        await delay(10)
      assert.equal(await readFile(target, 'utf8'), 'X')
      // 这时 CLI 的会话记录里还没有这次调用
      const transcripts = await readdir(join(home, 'claude', 'projects'), { recursive: true })
      const recorded = transcripts
        .filter((name) => String(name).endsWith('.jsonl'))
        .map((name) => readFileSync(join(home, 'claude', 'projects', String(name)), 'utf8'))
        .join('')
      assert.ok(!recorded.includes(callId), '这次调用不该已经进了会话记录')
      const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
      try {
        const row = db
          .prepare(
            'SELECT tool, input_json FROM native_tool_intents WHERE thread_id=? AND call_id=?',
          )
          .get(thread.id, callId) as { tool: string; input_json: string } | undefined
        assert.equal(row?.tool, 'Bash', '意图必须先于副作用落进入口的库')
      } finally {
        db.close()
      }
      const started = readFileSync(join(home, 'adapter', 'debug.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((entry) => entry.event === 'native.process.started' && entry.turnId === turn.id)
      assert.ok(started?.childPid)
      process.kill(started.childPid, 'SIGKILL')
      if (mode === 'adapter') {
        client.crash()
        await client.close()
        client = await ProtocolClient.start(home, url)
        await client.request('thread/resume', { threadId: thread.id })
      } else {
        const ended = await client.completed(turn.id)
        assert.notEqual(ended.status, 'completed')
      }
      let seen = ''
      model.enqueue((request) => {
        seen = JSON.stringify(request.messages)
        return [{ type: 'text', text: 'SECOND_DONE' }]
      })
      const { turn: next } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'LOST_SECOND 接着来' }],
      })
      const done = await client.completed(next.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.ok(seen.includes(LOST_NOTICE), '下一回合要告诉模型这次调用结果未知')
      assert.ok(seen.includes(`printf X >> '`), '要说清是哪一次调用')
      assert.ok(!seen.includes(callId), 'CLI 的会话记录里没有这次调用（否则测的不是这条路）')
      assert.ok(seen.includes('LOST_SECOND'))
      assert.equal(await readFile(target, 'utf8'), 'X', '不能重放')
      // 说过一次就删掉，再下一回合不再说
      const after = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
      try {
        assert.deepEqual(
          after.prepare('SELECT call_id FROM native_tool_intents WHERE call_id=?').all(callId),
          [],
        )
      } finally {
        after.close()
      }
      const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
      const user = read.thread.turns.at(-1).items.find((item: any) => item.type === 'userMessage')
      assert.ok(!JSON.stringify(user).includes(LOST_NOTICE), '记录里的用户消息还是用户原样的话')
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

// ---------- 记下的意图怎么核对：进了会话记录的删掉，没进、CLI 也不在了的告诉模型 ----------

async function intentStore(
  run: (store: SessionStore, file: FakeTranscript, dir: string) => Promise<void>,
) {
  await scratch(async (file, dir) => {
    const store = new SessionStore(join(dir, 'state.sqlite'))
    try {
      await run(store, file, dir)
    } finally {
      store.close()
    }
  })
}

const intentOf = (callId: string, path: string, fields: Partial<NativeToolIntent> = {}) => ({
  callId,
  tool: 'Bash',
  input: { command: `echo ${callId}` },
  sessionKey: 'thread',
  transcriptPath: path,
  agentId: null,
  ...fields,
})

test('SETTLE-001：进了会话记录的删掉；没进、CLI 不在了的交出来；没进、CLI 还在的留着', async () => {
  await intentStore(async (store, file) => {
    const [written, lost, pending, half] = [toolId(), toolId(), toolId(), toolId()]
    for (const id of [written, lost, pending, half])
      store.saveNativeToolIntent('thread', 'turn', intentOf(id, file.path))
    file.append(file.line({ type: 'user', message: { role: 'user', content: '开始' } }))
    file.append(file.assistant('msg_1', useBlock(written), 3))
    // 只差换行的半行不算写进去了
    file.append(file.assistant('msg_2', useBlock(half), 3).slice(0, -1))
    const intents = new NativeToolIntents(store)
    // CLI 还在：没进记录的都留着
    assert.deepEqual(await intents.settle('thread', new Set(['thread'])), [])
    assert.deepEqual(
      store.nativeToolIntents('thread').map((row) => row.callId),
      [lost, pending, half],
    )
    // CLI 不在了：没进记录的交出来，但不删（告诉过模型、那一回合结束后才删）
    const out = await intents.settle('thread', new Set())
    assert.deepEqual(
      out.map((row) => row.callId),
      [lost, pending, half],
    )
    assert.equal(out[0]?.turnId, 'turn')
    assert.deepEqual(out[0]?.input, { command: `echo ${lost}` })
    store.dropNativeToolIntents(
      'thread',
      out.map((row) => row.callId),
    )
    assert.deepEqual(store.nativeToolIntents('thread'), [])
    // 同一次调用再记一次不重复、不改原来的
    store.saveNativeToolIntent('thread', 'turn', intentOf(written, file.path))
    store.saveNativeToolIntent('thread', 'turn-2', intentOf(written, file.path))
    assert.equal(store.nativeToolIntents('thread')[0]?.turnId, 'turn')
    assert.deepEqual(await intents.settle('thread', new Set()), [])
    assert.deepEqual(store.nativeToolIntents('thread'), [])
  })
})

test('SETTLE-002：子代理的调用到 subagents/ 下面找；记录文件不见了算没写进去', async () => {
  await intentStore(async (store, file, dir) => {
    const agent = 'a0123456789abcdef'
    const sub = join(file.path.slice(0, -'.jsonl'.length), 'subagents')
    mkdirSync(sub, { recursive: true })
    const child = new FakeTranscript(join(sub, `agent-${agent}.jsonl`), randomUUID(), dir, agent)
    const [inChild, inMainOnly, gone] = [toolId(), toolId(), toolId()]
    child.append(child.assistant('msg_c', useBlock(inChild), 1))
    file.append(file.assistant('msg_m', useBlock(inMainOnly), 1))
    store.saveNativeToolIntent('thread', 'turn', intentOf(inChild, file.path, { agentId: agent }))
    // 子代理的调用在主会话的记录里不算
    store.saveNativeToolIntent(
      'thread',
      'turn',
      intentOf(inMainOnly, file.path, { agentId: agent }),
    )
    store.saveNativeToolIntent('thread', 'turn', intentOf(gone, join(dir, 'missing.jsonl')))
    const lost = await new NativeToolIntents(store).settle('thread', new Set())
    assert.deepEqual(
      lost.map((row) => row.callId),
      [inMainOnly, gone],
    )
    const notice = lostToolCallsNotice(lost)
    assert.match(notice, /outcome is unknown/)
    assert.ok(notice.includes(`- Bash (in subagent ${agent}): {"command":"echo ${inMainOnly}"}`))
    assert.ok(notice.includes(`- Bash: {"command":"echo ${gone}"}`))
    // 太长的参数截断
    assert.ok(
      lostToolCallsNotice([{ ...lost[1]!, input: { command: 'x'.repeat(5_000) } }]).length < 1_500,
    )
  })
})

test('SETTLE-003：回退掉的回合、删掉的会话，它们的意图跟着删', async () => {
  await intentStore(async (store, file, dir) => {
    const now = Math.floor(Date.now() / 1000)
    store.upsertThread({
      id: 'thread',
      sessionId: 'thread',
      forkedFromId: null,
      preview: '',
      name: null,
      archived: false,
      cwd: dir,
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      runtimeBackend: 'claude',
      claudeSessionId: 'original',
      codexSessionId: null,
      source: 'appServer',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
    } as any)
    for (const [id, startedAt] of [
      ['turn-old', now - 10],
      ['turn-new', now],
    ] as const)
      store.upsertTurn({
        id,
        threadId: 'thread',
        status: 'completed',
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        items: [],
        diff: '',
        error: null,
      } as any)
    store.saveNativeToolIntent('thread', 'turn-old', intentOf('old', file.path))
    store.saveNativeToolIntent('thread', 'turn-new', intentOf('new', file.path))
    assert.equal(store.deleteRecentTurns('thread', 1), 1)
    assert.deepEqual(
      store.nativeToolIntents('thread').map((row) => row.callId),
      ['old'],
    )
    store.deleteThread('thread')
    assert.deepEqual(store.nativeToolIntents('thread'), [])
  })
})
