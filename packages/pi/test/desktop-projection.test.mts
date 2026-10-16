import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { dispatch } from '../src/protocol.mjs'
import { PiServer } from '../src/server.mjs'
import { createUi } from '../src/ui.mjs'
import { assertResponse, assertServerRequest } from './schema.mjs'

test('Pi 原生菜单保持标签，问答必须阻塞且不复制选项描述', async () => {
  const requests: any[] = []
  let asksPlan = true
  const ui = createUi(
    async (method, params) => {
      const request = { threadId: 't', turnId: 'turn', itemId: 'item', ...params }
      assertServerRequest(method, request)
      assert.throws(() => assertServerRequest(method, { ...request, isBlocking: undefined }))
      requests.push(request)
      return { answers: { [params.questions[0].id]: { answers: ['1. Blue — Write Blue'] } } }
    },
    () => {},
    () => asksPlan,
  )
  assert.equal(
    await ui.select('Choose', ['1. Blue — Write Blue', 'Other (free-form)']),
    '1. Blue — Write Blue',
  )
  await ui.input('Name')
  await ui.confirm('Continue', 'Confirm choice')
  await ui.editor('Edit', 'Original text')
  assert.equal(requests.length, 4)
  assert.deepEqual(requests[0].questions[0].options, [
    { label: '1. Blue — Write Blue', description: '' },
    { label: 'Other (free-form)', description: '' },
  ])
  assert.ok(requests.every((r) => r.isBlocking === true))
  // 计划插件交了计划之后的那一问：发起回合的连接没声明 planConfirmation 时不问，等于关掉菜单；
  // 别的菜单照问
  const ready = 'Proposed plan ready. What next?\nImplement here keeps this planning conversation.'
  asksPlan = false
  assert.equal(await ui.select(ready, ['Implement here', 'Stay in Plan mode']), undefined)
  assert.equal(requests.length, 4)
  assert.equal(await ui.select('Plan mode', ['Stay in Plan mode']), '1. Blue — Write Blue')
  assert.equal(requests.length, 5)
  asksPlan = true
  await ui.select(ready, ['Implement here', 'Stay in Plan mode'])
  assert.equal(requests.length, 6)
  assert.match(requests[5].questions[0].question, /^Proposed plan ready\. What next\?/)
})

test('Pi runtime/info 使用实际版本并通过扩展 schema，版本只校验格式', async () => {
  const info = await dispatch(
    {} as PiServer,
    { id: 'p', send() {}, close() {} },
    'runtime/info',
    {},
  )
  assertResponse('runtime/info', info)
  // 下限由 Worker 比较；schema 接受更高稳定版，拒绝缺失与非法格式。
  for (const change of [
    { sdkVersion: '0.99.2' },
    { cliBuild: '0.99.2' },
    { nodeVersion: '24.19.0' },
    { pluginVersions: { ...info.pluginVersions, '@gotgenes/pi-subagents': '21.8.2' } },
  ])
    assertResponse('runtime/info', { ...info, ...change })
  for (const change of [
    { sdkVersion: 'v0.99.1' },
    { cliBuild: '0.99.2-beta.1' },
    { nodeVersion: '24' },
    { pluginVersions: {} },
  ])
    assert.throws(() => assertResponse('runtime/info', { ...info, ...change }))
})

// Pi 等会话里有了对话才写会话文件，文件里总有一句话（没说过话的会话照上游不进列表）
const firstWords = (timestamp: string) =>
  `${JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp, message: { role: 'user', content: '你好' } })}\n`

test('原生父子投影支持顶层、直接父级、所有后代和重启，metadata 返回真实 thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-projection-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const sessions = join(root, 'agent', 'sessions')
  await mkdir(sessions, { recursive: true })
  const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`)
  for (const [i, id] of ids.entries()) {
    const parentSession =
      i === 1 || i === 2 ? ids[i - 1] : i === 3 ? join(sessions, `${ids[0]}.jsonl`) : undefined
    await writeFile(
      join(sessions, `${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd: root, timestamp: '2026-10-01T00:00:00Z', parentSession })}\n${firstWords('2026-10-01T00:00:00Z')}`,
    )
  }
  let server = new PiServer(join(root, 'adapter'))
  const peer = { id: 'p', send() {}, close() {} }
  const call = async (method: string, params: any = {}) => {
    const result = await dispatch(server, peer, method, params)
    assertResponse(method, result)
    return result
  }
  try {
    for (let pass = 0; pass < 2; pass++) {
      const top = await call('thread/list')
      assert.deepEqual(new Set(top.data.map((t: any) => t.id)), new Set([ids[0], ids[3]]))
      const descendants = await call('thread/list', {
        ancestorThreadId: ids[0],
        sourceKinds: ['subAgentThreadSpawn'],
      })
      assert.deepEqual(new Set(descendants.data.map((t: any) => t.id)), new Set([ids[1], ids[2]]))
      assert.equal(
        descendants.data.find((t: any) => t.id === ids[2]).source.subAgent.thread_spawn.depth,
        2,
      )
      assert.deepEqual(
        (await call('thread/list', { parentThreadId: ids[0] })).data.map((t: any) => t.id),
        [ids[1]],
      )
      assert.equal((await call('thread/list', { sourceKinds: ['cli'] })).data.length, 0)
      await assert.rejects(
        call('thread/list', { parentThreadId: ids[0], ancestorThreadId: ids[0] }),
        /不能同时/,
      )
      const result = await call('thread/metadata/update', {
        threadId: ids[0],
        gitInfo: { branch: 'main' },
        daybreakEnabled: false,
      })
      assert.equal(result.thread.id, ids[0])
      assert.equal(result.thread.gitInfo.branch, 'main')
      assert.equal(result.thread.daybreakEnabled, false)
      assert.deepEqual(result.thread.turns, [])
      assert.throws(() => assertResponse('thread/metadata/update', {}))
      assert.equal(server.sessions.size, 0, '列表和 metadata 不创建执行会话')
      const project = (
        await call('project/create', {
          name: 'acceptance',
          roots: [{ path: root }],
          idempotencyKey: 'project',
        })
      ).project
      await call('thread/metadata/update', { threadId: ids[0], projectId: project.id })
      const members = await call('thread/list', { projectId: project.id })
      assert.deepEqual(
        members.data.map((t: any) => t.id),
        [ids[0]],
      )
      assert.deepEqual(
        (await call('thread/list', { projectId: null })).data.map((t: any) => t.id),
        [ids[3]],
      )
      const envelope = members.data[0]
      assert.deepEqual(
        (await call('thread/list', { projectId: project.id, cwd: [root] })).data,
        members.data,
      )
      assert.deepEqual((await call('thread/list', { cwd: [] })).data, [])
      const allPage = await call('thread/list', { limit: 1 })
      assert.ok(allPage.nextCursor)
      await assert.rejects(
        call('thread/list', { projectId: null, cursor: allPage.nextCursor }),
        /游标/,
      )
      assert.equal(envelope.projectId, project.id)
      assert.equal(envelope.cwd, root)
      assert.equal(envelope.path, null)
      assert.equal(envelope.threadSource, 'user')
      assert.equal(envelope.recencyAt, envelope.updatedAt)
      assert.equal(envelope.historyMode, 'legacy')
      assert.equal(envelope.section, null)
      assert.equal(envelope.isPinned, false)
      assert.equal(envelope.canAcceptDirectInput, true)
      assert.equal(envelope.activePermissionProfile, ':danger-full-access')
      const reread = await call('thread/read', { threadId: ids[0], includeTurns: false })
      assert.deepEqual(reread.thread, envelope)
      if (pass === 0) {
        // 模拟 CLI 修改 JSONL 后再刷新目录，适配元数据不可被原生索引覆盖。
        await writeFile(
          join(sessions, `${ids[0]}.jsonl`),
          `${JSON.stringify({ type: 'session', version: 3, id: ids[0], cwd: root, timestamp: '2026-10-02T00:00:00Z' })}\n${firstWords('2026-10-02T00:00:00Z')}`,
        )
        await server.close()
        server = new PiServer(join(root, 'adapter'))
        assert.equal(
          (await call('thread/list', { projectId: project.id })).data[0].projectId,
          project.id,
        )
      }
    }
  } finally {
    await server.close()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('置顶分组使用桌面固定 ID，thread/list 按 sectionId 与 isPinned 筛选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-sections-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const sessions = join(root, 'agent', 'sessions')
  await mkdir(sessions, { recursive: true })
  const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2']
  for (const id of ids)
    await writeFile(
      join(sessions, `${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd: root, timestamp: '2026-10-02T00:00:00Z' })}\n${firstWords('2026-10-02T00:00:00Z')}`,
    )
  const server = new PiServer(join(root, 'adapter'))
  const peer = { id: 'p', send() {}, close() {} }
  const call = async (method: string, params: any = {}) => {
    const result = await dispatch(server, peer, method, params)
    assertResponse(method, result)
    return result
  }
  const listIds = async (params: any) =>
    (await call('thread/list', params)).data.map((t: any) => t.id).sort()
  try {
    // 桌面查询置顶分组时，未置顶的会话不得出现（此前忽略 sectionId，全部被当成置顶）。
    assert.deepEqual(await listIds({ sectionId: PINNED_SECTION_ID }), [])
    assert.deepEqual(await listIds({ sectionId: null }), [...ids].sort())
    await call('thread/metadata/update', { threadId: ids[0], isPinned: true })
    assert.deepEqual(await listIds({ sectionId: PINNED_SECTION_ID }), [ids[0]])
    assert.deepEqual(await listIds({ sectionId: null }), [ids[1]])
    assert.deepEqual(await listIds({ isPinned: true }), [ids[0]])
    assert.deepEqual(await listIds({ isPinned: false }), [ids[1]])
    assert.deepEqual(await listIds({}), [...ids].sort())
    const pinned = (await call('thread/read', { threadId: ids[0], includeTurns: false })).thread
    assert.equal(pinned.isPinned, true)
    assert.deepEqual(pinned.section, PINNED_SECTION)
    const sections = await call('threadSection/list', {})
    assert.equal(sections.data[0].id, PINNED_SECTION_ID)
    await call('thread/section/move', { threadId: ids[1], sectionId: PINNED_SECTION_ID })
    await call('thread/section/move', { threadId: ids[0], sectionId: null })
    assert.deepEqual(await listIds({ sectionId: PINNED_SECTION_ID }), [ids[1]])
    assert.equal(
      (await call('thread/read', { threadId: ids[0], includeTurns: false })).thread.isPinned,
      false,
    )
    await assert.rejects(
      dispatch(server, peer, 'threadSection/delete', { sectionId: PINNED_SECTION_ID }),
      /内置置顶分组/,
    )
  } finally {
    await server.close()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('model/list 的默认思考强度取 Pi 对该模型实际生效的值，一定在可选项内', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-model-effort-'))
  const agentDir = join(root, 'agent')
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  await mkdir(agentDir, { recursive: true })
  const model = (id: string, extra: object) => ({
    id,
    name: id,
    input: ['text'],
    contextWindow: 32000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...extra,
  })
  // sparse 与 high-only 沿用 DeepSeek 两个模型的强度映射：都不支持 medium。
  const levels = { minimal: null, medium: null, high: 'high', max: 'max' }
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            model('sparse', { reasoning: true, thinkingLevelMap: { ...levels, low: 'low' } }),
            model('high-only', { reasoning: true, thinkingLevelMap: { ...levels, low: null } }),
            model('full', { reasoning: true }),
            model('plain', { reasoning: false }),
          ],
        },
      },
    }),
  )
  const server = new PiServer(join(root, 'adapter'))
  const peer = { id: 'p', send() {}, close() {} }
  const call = async (method: string, params: any) => {
    const result = await dispatch(server, peer, method, params)
    assertResponse(method, result)
    return result
  }
  const defaults = async () => {
    const listed = (await call('model/list', { cwd: root })).data
    return Object.fromEntries(
      listed
        .filter((m: any) => m.id.startsWith('local/'))
        .map((m: any) => {
          const options = m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort)
          assert.ok(options.includes(m.defaultReasoningEffort), `${m.id}: ${options}`)
          return [m.id.slice('local/'.length), m.defaultReasoningEffort]
        }),
    )
  }
  try {
    assert.deepEqual(await defaults(), {
      sparse: 'high',
      'high-only': 'high',
      full: 'medium',
      plain: 'off',
    })
    // 列表给出的默认值就是新会话实际生效的强度。
    const started = await call('thread/start', { cwd: root, model: 'local/sparse' })
    assert.equal(started.reasoningEffort, 'high')
    // 设置里的默认强度优先，仍钳制到各模型支持的范围。
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultThinkingLevel: 'low' }),
    )
    assert.deepEqual(await defaults(), {
      sparse: 'low',
      'high-only': 'high',
      full: 'low',
      plain: 'off',
    })
  } finally {
    await server.close()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
