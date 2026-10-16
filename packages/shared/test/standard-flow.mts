// 结构校验用的“常用流程”：一个不声明任何扩展的客户端把平时最常走的路走一遍。
// 握手、新建会话、一轮带工具调用和审批的回合、提问、打断、计划模式、列表与读取、改名、归档与恢复。
// 流程本身只断言“走通了”；服务端发来的每条消息与上游结构的出入由客户端一路记着，交给基线去比。
import assert from 'node:assert/strict'
import { type EntryScene, type SceneName, standardAnswer, textInput } from './compat-scene.mjs'
import type { StandardClient } from './standard-client.mjs'

export interface FlowReport {
  threadId: string
  /** 这个入口演不了、跳过去的回合 */
  skipped: SceneName[]
}

export async function runStandardFlow(
  client: StandardClient,
  scene: EntryScene,
): Promise<FlowReport> {
  const skipped: SceneName[] = []
  // experimentalApi 是上游自己的能力位，官方桌面端恒为真；我们自己的扩展一个都不声明
  await client.handshake(
    { name: 'litch-compat-standard', title: null, version: '1.0.0' },
    { experimentalApi: true },
  )
  client.onServerRequest = (method, params) => standardAnswer(method, params)

  const started = await client.ok('thread/start', { cwd: scene.cwd, ...scene.threadStart })
  const threadId: string = started.thread.id
  assert.equal(typeof threadId, 'string')

  const begin = async (name: SceneName) => {
    const script = await scene.script(name)
    if (!script) {
      skipped.push(name)
      return null
    }
    const reply = await client.ok('turn/start', {
      threadId,
      input: textInput(script.prompt),
      ...script.params,
    })
    return { id: reply.turn.id as string, script }
  }
  const mine = (params: any) => params.threadId === threadId

  // 一轮带工具调用和审批的回合：审批请求真的来过，同意之后回合正常结束
  const approval = await begin('approval')
  assert.ok(approval, `${scene.entry} 要能演带审批的回合`)
  await client.until(scene.approvalMethod, mine, '审批请求')
  assert.equal((await client.completed(approval.id)).status, 'completed', '带审批的回合')

  // 提问：有的入口不会提问
  const question = await begin('question')
  if (question) {
    await client.until('item/tool/requestUserInput', mine, '提问')
    assert.equal((await client.completed(question.id)).status, 'completed', '提问的回合')
  }

  // 打断：回合开始之后打断，结束时的状态是 interrupted，不带错误（用户打断不是出错：上游 turn/interrupt
  // 走 abort_all_tasks，TurnAbortedEvent 的 error 是 None，turn/completed 和读历史里都是 null）
  const slow = await begin('slow')
  assert.ok(slow, `${scene.entry} 要能演来得及打断的回合`)
  await client.until('turn/started', (params) => params.turn?.id === slow.id, '回合开始')
  if (slow.script.streams)
    await client.until('item/agentMessage/delta', (params) => params.turnId === slow.id, '头一段话')
  await client.ok('turn/interrupt', { threadId, turnId: slow.id })
  const interrupted = await client.completed(slow.id)
  slow.script.release?.()
  assert.equal(interrupted.status, 'interrupted', '被打断的回合')
  assert.equal(interrupted.error, null, '被打断的回合不带错误')

  // 打断之后会话照常能用
  const plain = await begin('plain')
  assert.ok(plain, `${scene.entry} 要能演只说一句话的回合`)
  assert.equal((await client.completed(plain.id)).status, 'completed', '打断之后的回合')

  // 计划模式，照官方桌面端的做法（research/codex-desktop-analysis-2026-10-12/04 第 2.6.4 节）：
  // 计划模式的回合带着计划条目正常结束，入口不在回合里问要不要执行（在回合里问是 planConfirmation 扩展，
  // 没声明的连接上不问）；桌面端自己问，选了执行就把协作模式切回 default、发一个新回合，
  // 话是固定的一行加计划全文
  if (scene.planMode) {
    const planning = scene.planMode
    const collaborationMode = (mode: 'plan' | 'default') => ({
      mode,
      settings: { model: planning.model, reasoning_effort: null, developer_instructions: null },
    })
    const from = client.received.length
    planning.plan()
    const planned = (
      await client.ok('turn/start', {
        threadId,
        input: textInput('先做个计划。'),
        collaborationMode: collaborationMode('plan'),
      })
    ).turn.id
    assert.equal((await client.completed(planned)).status, 'completed', '计划模式的回合')
    const plan = client.received
      .filter(
        (entry) =>
          entry.method === 'item/completed' &&
          entry.params?.turnId === planned &&
          entry.params.item?.type === 'plan',
      )
      .at(-1)
      ?.params.item.text.trim()
    assert.ok(plan, '计划模式的回合里有计划条目')
    assert.ok(
      !client.received.slice(from).some((entry) => entry.method === 'item/tool/requestUserInput'),
      '入口没在回合里问要不要执行',
    )
    planning.implement()
    const implemented = (
      await client.ok('turn/start', {
        threadId,
        input: textInput(`PLEASE IMPLEMENT THIS PLAN:\n${plan}`),
        collaborationMode: collaborationMode('default'),
      })
    ).turn.id
    assert.equal((await client.completed(implemented)).status, 'completed', '照计划执行的回合')
  }

  // 列表与读取
  const listed = await client.ok('thread/list', { limit: 50 })
  assert.ok(
    listed.data.some((thread: any) => thread.id === threadId),
    '会话在列表里',
  )
  const read = await client.ok('thread/read', { threadId, includeTurns: true })
  assert.ok(read.thread.turns.length >= 3, '读回来的会话带着回合')
  // 读历史时被打断的那个回合也一样：状态是 interrupted，不带错误
  const stopped = (turns: any[]) => turns.find((turn: any) => turn.id === slow.id)
  assert.equal(stopped(read.thread.turns)?.status, 'interrupted', '读历史：被打断的回合')
  assert.equal(stopped(read.thread.turns)?.error, null, '读历史：被打断的回合不带错误')
  // 翻回合列表、恢复会话里带着它的话也一样
  const paged = stopped((await client.ok('thread/turns/list', { threadId }))?.data ?? [])
  if (paged) assert.equal(paged.error, null, '翻回合列表：被打断的回合不带错误')
  await client.ok('thread/items/list', { threadId })
  const resumed = stopped((await client.ok('thread/resume', { threadId }))?.thread?.turns ?? [])
  if (resumed) assert.equal(resumed.error, null, '恢复会话：被打断的回合不带错误')
  await client.ok('thread/name/set', { threadId, name: '兼容性流程' })

  // 归档与恢复。先后照上游：先回应答，再广播 thread/archived、thread/unarchived
  // （rust-v0.162.0-alpha.20 的 thread_archive、thread_unarchive）
  await client.ok('thread/archive', { threadId })
  await client.until('thread/archived', mine)
  assertReplyFirst(client, 'thread/archive', 'thread/archived', threadId)
  const archived = await client.ok('thread/list', { archived: true, limit: 50 })
  assert.ok(
    archived.data.some((thread: any) => thread.id === threadId),
    '归档之后在已归档的列表里',
  )
  await client.ok('thread/unarchive', { threadId })
  await client.until('thread/unarchived', mine)
  assertReplyFirst(client, 'thread/unarchive', 'thread/unarchived', threadId)
  await client.ok('thread/unsubscribe', { threadId })
  return { threadId, skipped }
}

/** 最近一次 method 请求的应答，要排在这个会话的那条 notification 前面 */
function assertReplyFirst(
  client: StandardClient,
  method: string,
  notification: string,
  threadId: string,
): void {
  const request = client.sent.findLast((message) => message.method === method && 'id' in message)
  assert.ok(request, `发过 ${method}`)
  const reply = client.received.findIndex((message) => message.id === request.id && !message.method)
  const notified = client.received.findIndex(
    (message) => message.method === notification && message.params?.threadId === threadId,
  )
  assert.ok(
    reply >= 0 && notified > reply,
    `${method} 的应答要先于 ${notification}（应答在第 ${reply} 条，通知在第 ${notified} 条）`,
  )
}
