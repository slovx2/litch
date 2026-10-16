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
import { mkdtemp, open, rm } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { getSessionMessages, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { ToolIntentTranscripts, TranscriptTail } from '../src/transcript-tail.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 原生工具执行之前，PreToolUse 钩子确认这次调用（tool_use 块）已经写进 CLI 的会话记录，确认不了就拒绝
// （防止入口重启、恢复时同一个工具被执行两次），同时把那条消息的用量交给目标、登记工具意图。
// 以前每次都用 SDK 把整个会话记录读出来、逐行解析，钩子触发时那一行多半还没写，隔 25 毫秒再读，
// 一个回合的开销随调用次数平方涨。这里不看钟，数两样和机器快慢无关的量：
//   从会话记录（主会话的和子代理的）里一共读了多少字节；
//   解析了多少行会话记录（JSON.parse 的参数里带着会话 ID 的）。
// 用的是真的原生运行时，只把 SDK 换成照着念的：它像 CLI 一样往会话记录里写（每个内容块一行、
// 同一条消息的几行共用消息 id；有的在钩子来之前写好，有的晚一点写，有的先写半行），再调钩子。
// SDK 的 getSessionMessages、getSubagentMessages 用真的（旧做法调的就是它们）。

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
/** 交给目标用量的那条消息：在用例里换掉运行时的 goalUsage，记下它收到的 */
function spyGoalUsage(runtime: NativeClaudeRuntime): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = []
  const goalUsage = Reflect.get(runtime, 'goalUsage') as (...args: unknown[]) => Promise<void>
  Reflect.set(runtime, 'goalUsage', function (this: unknown, pending: unknown, message: any) {
    seen.push(message)
    return goalUsage.call(this, pending, message)
  })
  return seen
}

const CALLS = 150
const OUTPUT = 4000

test('INTENT-001：一个回合里一百多次工具调用，确认落盘读的字节数和解析的行数不随会话记录变长涨', {
  timeout: 300_000,
}, async (t) => {
  await sandbox(async ({ projects, cwd, transcript, sessionId }) => {
    const main = new FakeTranscript(transcript, sessionId, cwd)
    // 子代理的记录在会话目录的 subagents/ 下面，工作流的子代理再套一层
    const subagents = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
    mkdirSync(join(subagents, 'workflows', 'run-1'), { recursive: true })
    const childId = 'a0123456789abcdef'
    const nestedId = 'b0123456789abcdef'
    const child = new FakeTranscript(
      join(subagents, `agent-${childId}.jsonl`),
      sessionId,
      cwd,
      childId,
    )
    const nested = new FakeTranscript(
      join(subagents, 'workflows', 'run-1', `agent-${nestedId}.jsonl`),
      sessionId,
      cwd,
      nestedId,
    )
    main.append(
      `${JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: new Date().toISOString(), sessionId })}\n` +
        main.line({ type: 'user', message: { role: 'user', content: baseContext.prompt } }) +
        main.line({
          type: 'attachment',
          attachment: { type: 'skill_listing', content: 'y'.repeat(12_000) },
        }),
    )
    child.append(child.line({ type: 'user', message: { role: 'user', content: '子代理：读文件' } }))
    nested.append(
      nested.line({ type: 'user', message: { role: 'user', content: '工作流：读文件' } }),
    )

    const calls: Array<{ id: string; agent: string | undefined; input: Record<string, unknown> }> =
      []
    const denied: string[] = []
    const runtime = new NativeClaudeRuntime()
    const usages = spyGoalUsage(runtime)
    Reflect.set(runtime, 'sdk', {
      getSessionMessages,
      getSubagentMessages,
      query: ({ options }: { options: Record<string, any> }) =>
        (async function* () {
          for (let index = 0; index < CALLS; index++) {
            const where = index % 10 === 3 ? child : index % 10 === 7 ? nested : main
            const agent = where === child ? childId : where === nested ? nestedId : undefined
            const messageId = `msg_${index}`
            // 有的消息里是并行的两次调用：同一条消息、各占一行
            const ids = index % 10 === 5 ? [toolId(), toolId()] : [toolId()]
            const input = { file_path: join(cwd, `f${index}.txt`) }
            let text = where.assistant(messageId, { type: 'text', text: `看第 ${index} 个` }, 1)
            for (const id of ids)
              text += where.assistant(
                messageId,
                { type: 'tool_use', id, name: 'Read', input },
                index % 2 ? 1 : 37,
              )
            // 写进会话记录的时机：钩子来之前写好、晚一点写、先写半行晚一点写完
            if (index % 3 === 0) where.append(text)
            else if (index % 3 === 1) {
              const half = Math.floor(text.length / 2)
              where.append(text.slice(0, half))
              setTimeout(() => where.append(text.slice(half)), 40)
            } else setTimeout(() => where.append(text), 40)
            for (const id of ids) {
              const event = {
                hook_event_name: 'PreToolUse',
                session_id: sessionId,
                transcript_path: transcript,
                cwd,
                tool_name: 'Read',
                tool_input: input,
                tool_use_id: id,
                ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}),
              }
              const reason = await preToolUse(options, event, id)
              if (reason) denied.push(`${index} ${id}: ${reason}`)
              calls.push({ id, agent, input })
            }
            for (const id of ids) where.append(where.result(id, `${index}: ${'x'.repeat(OUTPUT)}`))
          }
          yield { type: 'result', subtype: 'success', result: '看完了。', session_id: sessionId }
        })(),
    })
    const intents: Array<[string, string, Record<string, unknown>]> = []
    const events: RuntimeEvent[] = []
    const metered = await meter(projects, sessionId)
    try {
      await runtime.runTurn(
        { ...baseContext, cwd },
        {
          onEvent: async (event) => {
            events.push(event)
          },
          onPermissionRequest: async () => ({ decision: 'accept' }),
          onUserInputRequest: async () => ({ answers: {} }),
          onNativeToolIntent: (callId, name, args) => {
            intents.push([callId, name, args])
          },
        },
      )
    } finally {
      metered.stop()
    }
    const { bytes, lines } = metered.counts

    assert.deepEqual(denied, [], '每次调用都写进了会话记录，钩子都该放行')
    assert.deepEqual(
      intents,
      calls.map((call) => [call.id, 'Read', call.input]),
    )
    // 交给目标用量的，就是 SDK 交出来的那一行的 message（字段、用量一样）
    const listed: Record<string, Awaited<ReturnType<typeof getSessionMessages>>> = {
      main: await getSessionMessages(sessionId, { dir: cwd }),
      [childId]: await getSubagentMessages(sessionId, childId, { dir: cwd }),
      [nestedId]: await getSubagentMessages(sessionId, nestedId, { dir: cwd }),
    }
    const fromSdk = (call: (typeof calls)[number]) =>
      listed[call.agent ?? 'main']?.find((entry) => {
        const content = (entry.message as { content?: unknown }).content
        return (
          Array.isArray(content) &&
          content.some((block) => block.type === 'tool_use' && block.id === call.id)
        )
      })?.message
    assert.deepEqual(usages, calls.map(fromSdk))
    assert.ok(
      events.some((event) => event.type === 'goal_usage'),
      '目标用量照常发出',
    )

    // 两样量。会话记录一共多大：每个字节读一遍是线性的；以前每次调用（每隔 25 毫秒）都整份读一遍
    const size = [main, child, nested].reduce((sum, file) => sum + statSync(file.path).size, 0)
    t.diagnostic(
      `${calls.length} 次调用，会话记录共 ${size} 字节：读了 ${bytes} 字节（上限 ${size * 2}），解析了 ${lines} 行（上限 ${calls.length * 2}）`,
    )
    assert.ok(size * 2 < (calls.length * size) / 10, '这个上限得比平方级的量小得多才有意义')
    assert.ok(bytes < size * 2, `从会话记录读了 ${bytes} 字节，记录共 ${size} 字节`)
    assert.ok(lines < calls.length * 2, `解析了 ${lines} 行会话记录，调用 ${calls.length} 次`)
  })
})

test('INTENT-002：调用没写进会话记录、只写了半行、写在主会话里标着 isSidechain 的行里，都拒绝执行', {
  timeout: 60_000,
}, async () => {
  await sandbox(async ({ cwd, transcript, sessionId }) => {
    const main = new FakeTranscript(transcript, sessionId, cwd)
    const [written, missing, half, sidechain] = [toolId(), toolId(), toolId(), toolId()]
    const block = (id: string) => ({
      type: 'tool_use',
      id,
      name: 'Read',
      input: { file_path: cwd },
    })
    main.append(main.line({ type: 'user', message: { role: 'user', content: '开始' } }))
    main.append(main.assistant('msg_ok', block(written), 3))
    main.append(
      main.line({
        type: 'assistant',
        isSidechain: true,
        message: { id: 'msg_side', role: 'assistant', content: [block(sidechain)] },
      }),
    )
    // 最后一行没写完：整行都在，只差换行
    main.append(main.assistant('msg_half', block(half), 3).slice(0, -1))
    const runtime = new NativeClaudeRuntime()
    let decisions: Array<string | null> = []
    Reflect.set(runtime, 'sdk', {
      getSessionMessages,
      getSubagentMessages,
      query: ({ options }: { options: Record<string, any> }) =>
        (async function* () {
          decisions = await Promise.all(
            [written, missing, half, sidechain].map((id) =>
              preToolUse(
                options,
                {
                  hook_event_name: 'PreToolUse',
                  session_id: sessionId,
                  transcript_path: transcript,
                  cwd,
                  tool_name: 'Read',
                  tool_input: { file_path: cwd },
                  tool_use_id: id,
                },
                id,
              ),
            ),
          )
          yield { type: 'result', subtype: 'success', result: 'done', session_id: sessionId }
        })(),
    })
    await runtime.runTurn(
      { ...baseContext, cwd },
      {
        onEvent: async () => {},
        onPermissionRequest: async () => ({ decision: 'accept' }),
        onUserInputRequest: async () => ({ answers: {} }),
      },
    )
    const unconfirmed = '原生工具意图未能确认落盘或回合已取消，禁止执行。'
    assert.deepEqual(decisions, [null, unconfirmed, unconfirmed, unconfirmed])
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
    assert.ok(!requests.includes('未能确认落盘'), '有工具调用被钩子拒了')
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
    const log = readFileSync(join(home, 'adapter', 'debug.jsonl'), 'utf8')
    assert.ok(!log.includes('native.toolIntent.unconfirmed'))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
