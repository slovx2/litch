import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { declaredExtensions, declineNote } from '../../shared/src/harness-declaration.mjs'
import { approvalRequest, deniedMessage } from '../src/approval-request.mjs'
import { Daemon } from './fixtures/daemon.mjs'
import { declaring, declineWithNoteView } from './fixtures/extension-wire.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { descendants, killAll } from './fixtures/process-tree.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// “拒绝时附说明”（扩展 declineWithNote，定义在 protocol/extensions/decline-with-note.json）：
// 只有握手时声明了它的连接才在审批请求里看到这个决定；没声明的连接收到的和加这项扩展之前逐字段相同。

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const text = (value: string) => [{ type: 'text', text: value }]

const ids = {
  threadId: 'thread',
  turnId: 'turn',
  itemId: 'item',
  requestId: 'request',
  cwd: '/work',
}

const permission = (toolName: string, input: Record<string, unknown>) =>
  ({
    type: 'permission_request',
    requestId: 'runtime-request',
    toolUseId: 'toolu',
    toolName,
    input,
  }) as const

// 加这项扩展之前两类审批请求的参数，一个字段一个字段照抄下来的。标准的那份必须一直等于它。
const standardCommand = (startedAtMs: unknown) => ({
  threadId: 'thread',
  turnId: 'turn',
  itemId: 'item',
  startedAtMs,
  approvalId: 'request',
  reason: null,
  command: 'echo hi',
  cwd: '/work',
  commandActions: [],
  additionalPermissions: null,
  proposedExecpolicyAmendment: null,
  proposedNetworkPolicyAmendments: null,
  availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
})
const standardFileChange = (startedAtMs: unknown) => ({
  threadId: 'thread',
  turnId: 'turn',
  itemId: 'item',
  startedAtMs,
  reason: null,
  grantRoot: null,
})

test('NOTE-001：标准的那份参数和加扩展之前逐字段相同，带扩展的那份只多出决定列表', () => {
  const command = approvalRequest(permission('Bash', { command: 'echo hi' }), ids)
  assert.equal(command.method, 'item/commandExecution/requestApproval')
  assert.equal(typeof command.params.startedAtMs, 'number')
  assert.deepEqual(command.params, standardCommand(command.params.startedAtMs))
  assert.deepEqual(command.paramsWithNote, {
    ...command.params,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel'],
  })

  const write = approvalRequest(permission('Write', { file_path: '/work/a', content: 'a' }), ids)
  assert.equal(write.method, 'item/fileChange/requestApproval')
  assert.deepEqual(write.params, standardFileChange(write.params.startedAtMs))
  // “这个会话里都允许”是按命令原文记的，改文件的调用没有命令原文：选了它下次照样会问，所以不列。
  assert.deepEqual(write.paramsWithNote, {
    ...write.params,
    availableDecisions: ['accept', 'decline', 'declineWithNote', 'cancel'],
  })

  assert.equal(deniedMessage({ decision: 'decline' }), 'denied by user')
  assert.equal(
    deniedMessage({ decision: 'decline', note: '改用 /tmp' }),
    'denied by user. The user left this note explaining why: 改用 /tmp',
  )
})

test('NOTE-002：握手里的声明与应答里的说明怎么读', () => {
  const declared = (capabilities: unknown) => [...declaredExtensions({ capabilities })]
  assert.deepEqual(declared({ litchExtensions: ['harness', 'declineWithNote'] }), [
    'harness',
    'declineWithNote',
  ])
  // 没带、带错了类型，都当作一个也没声明。
  for (const capabilities of [null, undefined, {}, { litchExtensions: 'declineWithNote' }, []])
    assert.deepEqual(declared(capabilities), [])
  assert.deepEqual(declared({ litchExtensions: ['a', 1, null, 'b'] }), ['a', 'b'])
  assert.deepEqual([...declaredExtensions(null)], [])

  const note = (decision: unknown) => declineNote({ decision })
  assert.equal(note({ declineWithNote: { note: '  先别动  ' } }), '先别动')
  // 没写、只有空白、不是字符串：都是普通的拒绝。
  assert.equal(note({ declineWithNote: { note: '   ' } }), '')
  assert.equal(note({ declineWithNote: {} }), '')
  assert.equal(note({ declineWithNote: { note: 7 } }), '')
  assert.equal(note({ declineWithNote: { note: 'x'.repeat(5000) } })?.length, 4000)
  // 别的决定不归这里管。
  for (const decision of ['decline', 'accept', null, { acceptWithExecpolicyAmendment: {} }])
    assert.equal(note(decision), null)
  assert.equal(declineNote(null), null)
})

// 模拟运行时下跑一个命令审批和一个文件改动审批，返回客户端收到的两条请求的参数。
async function approvalsSeen(
  capabilities: Record<string, unknown> | null,
  answer: unknown,
): Promise<{ command: any; fileChange: any; outputs: string[]; written: boolean }> {
  const home = await mkdtemp(join(tmpdir(), 'decline-note-mock-'))
  const client = await ProtocolClient.start(
    home,
    'http://127.0.0.1:1',
    true,
    'api-key',
    {},
    capabilities,
  )
  // 没声明扩展的连接不装这个钩子：收到的内容必须原样通过标准 schema。
  if (capabilities) client.standardView = declineWithNoteView
  const seen: Record<string, any> = {}
  client.onServerRequest = async (method, params) => {
    seen[method] = params
    return answer
  }
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':workspace',
    })
    for (const prompt of ['approval', 'create a file named noted.txt']) {
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: text(prompt),
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
    }
    const { turns } = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    const outputs = turns
      .flatMap((turn: any) => turn.items)
      .filter((item: any) => item.type === 'commandExecution')
      .map((item: any) => `${item.status}:${item.aggregatedOutput ?? ''}`)
    return {
      command: seen['item/commandExecution/requestApproval'],
      fileChange: seen['item/fileChange/requestApproval'],
      outputs,
      written: await exists(join(home, 'noted.txt')),
    }
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('NOTE-003：没声明扩展的连接收到的审批请求和标准协议逐字段相同', {
  timeout: 60_000,
}, async () => {
  // 完全不声明，和只声明了别的扩展，都算没声明这一项。
  for (const capabilities of [null, { litchExtensions: ['harness', 'project'] }]) {
    // 这类连接不装校验钩子：两条请求都原样过了标准 schema 的严格校验。
    const home = await mkdtemp(join(tmpdir(), 'decline-note-plain-'))
    const client = await ProtocolClient.start(
      home,
      'http://127.0.0.1:1',
      true,
      'api-key',
      {},
      capabilities,
    )
    const seen: Record<string, any> = {}
    client.onServerRequest = async (method, params) => {
      seen[method] = params
      return { decision: 'decline' }
    }
    try {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        permissions: ':workspace',
      })
      const turnIds: string[] = []
      for (const prompt of ['approval', 'create a file named plain.txt']) {
        const { turn } = await client.request('turn/start', {
          threadId: thread.id,
          input: text(prompt),
        })
        turnIds.push(turn.id)
        assert.equal((await client.completed(turn.id)).status, 'completed')
      }
      const command = seen['item/commandExecution/requestApproval']
      assert.deepEqual(command, {
        ...standardCommand(command.startedAtMs),
        threadId: thread.id,
        turnId: turnIds[0],
        itemId: command.itemId,
        approvalId: command.approvalId,
        command: 'echo mock approval',
        // 命令在会话的目录里跑，和条目上的一样
        cwd: thread.cwd,
      })
      const fileChange = seen['item/fileChange/requestApproval']
      assert.deepEqual(fileChange, {
        ...standardFileChange(fileChange.startedAtMs),
        threadId: thread.id,
        turnId: turnIds[1],
        itemId: fileChange.itemId,
      })
      assert.equal('availableDecisions' in fileChange, false)
      assert.equal(await exists(join(home, 'plain.txt')), false)
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})

test('NOTE-004：声明了扩展的连接看到“拒绝并附说明”，答了它等于带着一句话的拒绝', {
  timeout: 60_000,
}, async () => {
  const noted = await approvalsSeen(declaring('declineWithNote'), {
    decision: { declineWithNote: { note: '改用 /tmp' } },
  })
  assert.deepEqual(noted.command.availableDecisions, [
    'accept',
    'acceptForSession',
    'decline',
    'declineWithNote',
    'cancel',
  ])
  assert.deepEqual(noted.fileChange.availableDecisions, [
    'accept',
    'decline',
    'declineWithNote',
    'cancel',
  ])
  // 除了决定列表，别的字段和标准的一样。
  assert.deepEqual(Object.keys(noted.command).sort(), Object.keys(standardCommand(0)).sort())
  assert.deepEqual(
    Object.keys(noted.fileChange).sort(),
    [...Object.keys(standardFileChange(0)), 'availableDecisions'].sort(),
  )
  // 调用被拒绝、没有执行，回合照常结束；条目是“已拒绝”、没有输出，说明只进交给模型的工具结果
  // （模型那头看到什么由 NOTE-005 对着真实 CLI 量）。
  assert.equal(noted.written, false)
  assert.deepEqual(noted.outputs, ['declined:'])

  // 没写说明（只有空白）和普通的拒绝一样。
  const blank = await approvalsSeen(declaring('declineWithNote'), {
    decision: { declineWithNote: { note: '  ' } },
  })
  const plain = await approvalsSeen(declaring('declineWithNote'), { decision: 'decline' })
  assert.deepEqual(blank.outputs, ['declined:'])
  assert.deepEqual(plain.outputs, blank.outputs)
  assert.equal(blank.written, false)
})

const toolResult = (request: ModelRequest, id: string): any =>
  (request.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)

test('NOTE-005：带说明拒绝之后模型在工具结果里看到这句话；没写说明的拒绝和以前一样', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'decline-note-native-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    declaring('declineWithNote'),
  )
  client.standardView = declineWithNoteView
  const asked: Array<{ method: string; decisions: unknown }> = []
  let answer: unknown = { decision: 'decline' }
  client.onServerRequest = async (method, params) => {
    asked.push({ method, decisions: params.availableDecisions })
    return answer
  }
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':workspace',
    })
    // 一轮：模型调用一个要问的工具，用户按 reply 作答，返回模型下一次请求里这次调用的工具结果。
    const declined = async (id: string, tool: Record<string, unknown>, reply: unknown) => {
      answer = reply
      let result: any
      model.enqueue(() => [{ type: 'tool_use', id, ...tool }])
      model.enqueue((request) => {
        result = toolResult(request, id)
        return [{ type: 'text', text: 'UNDERSTOOD' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: text(`执行 ${id}`),
      })
      // 拒绝不打断回合：模型带着工具结果接着说。
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      assert.ok(result, '被拒绝的调用也要有工具结果回到模型')
      assert.equal(result.is_error, true)
      return JSON.stringify(result.content)
    }
    const bash = {
      name: 'Bash',
      input: { command: 'printf ran > ran.txt', description: 'write a marker' },
    }
    const write = { name: 'Write', input: { file_path: join(home, 'ran.txt'), content: 'ran' } }
    const note = (value: string) => ({ decision: { declineWithNote: { note: value } } })

    const command = await declined('toolu_note_bash', bash, note('先别动这个目录，改用 /tmp'))
    assert.match(command, /denied by user/)
    assert.match(command, /The user left this note explaining why: 先别动这个目录，改用 \/tmp/)
    const file = await declined('toolu_note_write', write, note('这个文件由我自己来写'))
    assert.match(file, /The user left this note explaining why: 这个文件由我自己来写/)

    const plain = await declined('toolu_plain_bash', bash, { decision: 'decline' })
    assert.match(plain, /denied by user/)
    assert.doesNotMatch(plain, /note/)
    assert.equal(await declined('toolu_blank_bash', bash, note('   ')), plain, '空说明等同普通拒绝')

    assert.equal(await exists(join(home, 'ran.txt')), false, '被拒绝的调用都没有执行')
    assert.deepEqual(asked, [
      {
        method: 'item/commandExecution/requestApproval',
        decisions: ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel'],
      },
      {
        method: 'item/fileChange/requestApproval',
        decisions: ['accept', 'decline', 'declineWithNote', 'cancel'],
      },
      {
        method: 'item/commandExecution/requestApproval',
        decisions: ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel'],
      },
      {
        method: 'item/commandExecution/requestApproval',
        decisions: ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel'],
      },
    ])
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('NOTE-006：同一条审批请求先后送给不同的连接：每次按那条连接有没有声明来给参数', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'decline-note-daemon-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const daemon = await Daemon.start(home, await model.start())
  const method = 'item/fileChange/requestApproval'
  const target = join(workspace, 'resent.txt')
  try {
    // 没声明扩展的连接发起回合，收到标准形状的请求。
    const first = await daemon.connect('plain-first')
    const { thread } = await first.request('thread/start', {
      cwd: workspace,
      permissions: ':workspace',
    })
    let result: any
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_resent',
        name: 'Write',
        input: { file_path: target, content: 'RESENT' },
      },
    ])
    model.enqueue((request) => {
      result = toolResult(request, 'toolu_resent')
      return [{ type: 'text', text: 'UNDERSTOOD' }]
    })
    const { turn } = await first.request('turn/start', {
      threadId: thread.id,
      input: text('写一个文件'),
    })
    const original = await first.serverRequest(method)
    assert.equal('availableDecisions' in original.params, false)
    await first.disconnect()

    // 声明了扩展的连接接手：同一条请求、同一个 ID，多出决定列表。
    const aware = await daemon.connect('aware', declaring('declineWithNote'), declineWithNoteView)
    await aware.request('thread/resume', { threadId: thread.id })
    const extended = await aware.serverRequest(method)
    assert.equal(extended.id, original.id)
    assert.deepEqual(extended.params, {
      ...original.params,
      availableDecisions: ['accept', 'decline', 'declineWithNote', 'cancel'],
    })
    await aware.disconnect()

    // 又换回没声明的连接：扩展内容没有跟过去，和最初收到的一模一样。
    const later = await daemon.connect('plain-later')
    await later.request('thread/resume', { threadId: thread.id })
    const replayed = await later.serverRequest(method)
    assert.deepEqual(
      { id: replayed.id, params: replayed.params },
      { id: original.id, params: original.params },
    )
    await later.disconnect()
    assert.equal(model.requests.length, 1, '换连接不等于拒绝')

    // 最后由声明过的连接带着说明拒绝：模型看到这句话。
    const answering = await daemon.connect(
      'aware-again',
      declaring('declineWithNote'),
      declineWithNoteView,
    )
    await answering.request('thread/resume', { threadId: thread.id })
    const pending = await answering.serverRequest(method)
    answering.answer(pending, { decision: { declineWithNote: { note: '换一个文件名' } } })
    assert.equal((await answering.completed(turn.id)).status, 'completed')
    assert.match(JSON.stringify(result?.content), /explaining why: 换一个文件名/)
    assert.equal(await exists(target), false)
    model.assertConsumed()
  } finally {
    const tree = descendants(daemon.process.pid as number).map((row) => row.pid)
    await daemon.close()
    await model.close()
    killAll(tree)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
