#!/usr/bin/env node
// 手动经理角色评测，会花真模型的钱；不进 CI、不挂 npm test，角色评判由读 digest.md 的人做。
// 准备（Node 24；Go 要在 PATH）：
//   npm ci && npm ci --prefix packages/claude
//   npm run build --prefix packages/claude && npm run build --prefix packages/device
//   node scripts/build-cli.mjs
// 假跑：CHA_CLAUDE_CLI=/隔离副本/claude node scripts/eval-manager-role.mjs --fake
// 真跑：预先通过环境注入 EVAL_ANTHROPIC_BASE_URL、EVAL_ANTHROPIC_TOKEN、EVAL_MODEL、EVAL_SMALL_MODEL，
//   CHA_CLAUDE_CLI=/隔离副本/claude node scripts/eval-manager-role.mjs --out /产物目录 --timeout 300
// --timeout 是每步等待预算（秒，默认 180）；超时记录后打断仍在跑的回合，再继续下一步。
// --out 须为空目录。缺省 /Volumes/workspace/tyrs-hand/litch-wt/_mgr/role-eval/<时间>/。
// 真跑不添加任何夹具提示。--fake 另发“经理：”/“会话：”触发回合，明确记入证据，只检验驱动。
// 模型用 Litch providers/upsert 配置；密钥仅进临时设备的 0600 密钥文件，退出时删除临时状态。
// 环境白名单隔离 HOME/CLAUDE_CONFIG_DIR/CODEX_HOME，不读个人配置，不安装/升级 harness。
// 审批：on-request + 自定义沙箱档位，仅本次 work/ 与设备工作树根可写；网络和密钥目录禁止模型工具访问。
// 自动按次批准沙箱检出内的文件/命令请求；不批准额外权限、外部 MCP，不代答模型的产品问题。
// 线由设备默认开工作树，继承经理的权限与模型；既不使用 bypassPermissions，也不加 skip-permissions。
// 默认开场要求先不开线；若真模型没有开线/提出决策，第 5/6 步据实记录，绝不强造对象。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  boardChanges,
  digest,
  evidenceWriter,
  itemText,
  repositoryEvidence,
  transcriptMarkdown,
  turnEvidence,
} from './eval-manager-role-evidence.mjs'
import { createTodo, decisionFixture, git } from './eval-manager-role-fixture.mjs'
import { delay, startRuntime } from './eval-manager-role-runtime.mjs'

const { values } = parseArgs({
  options: {
    fake: { type: 'boolean', default: false },
    out: { type: 'string' },
    timeout: { type: 'string', default: '180' },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(
    readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .join('\n'),
  )
  process.exit(0)
}
const timeout = Number(values.timeout) * 1000
if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('--timeout 必须是至少 1 秒的数字')
const options = {
  fake: values.fake,
  baseUrl: values.fake ? null : process.env.EVAL_ANTHROPIC_BASE_URL,
  token: values.fake ? 'role-eval-fixture-only' : process.env.EVAL_ANTHROPIC_TOKEN,
  model: values.fake ? 'fixture-manager' : process.env.EVAL_MODEL,
  smallModel: values.fake ? 'fixture-small' : process.env.EVAL_SMALL_MODEL,
}
if (!values.fake && Object.values(options).some((value) => value === undefined || value === ''))
  throw new Error('真跑需设置四项 EVAL_* 环境变量，详见文件头部')
// 共用假模型的可选原始请求转储不适用于本驱动；证据只走统一脱敏出口。
delete process.env.LITCH_FIXTURE_DUMP
const output = resolve(
  values.out ??
    `/Volumes/workspace/tyrs-hand/litch-wt/_mgr/role-eval/${new Date().toISOString().replaceAll(':', '-')}`,
)
if (existsSync(output) && readdirSync(output).length)
  throw new Error('--out 必须为空，避免覆盖以前的评测')
mkdirSync(output, { recursive: true, mode: 0o700 })
const writer = evidenceWriter(output, options.token)
const steps = []
const run = {
  fake: options.fake,
  model: options.model,
  smallModel: options.smallModel,
  startedAt: new Date().toISOString(),
  maxRunningLines: 0,
  approval: 'on-request，自定义权限档位限定本次沙箱；单次批准文件/命令，不批准额外权限。',
}
let runtime
let stopRuntime
let manager
let lastBoard
const seenTurns = new Set()
const lines = new Map()
let shuttingDown = false
const saveIndex = () => {
  writer.write('run.json', run)
  writer.write('events.json', runtime?.client.frames ?? [])
  writer.write('digest.md', digest(run, steps, runtime?.client.frames ?? []))
}
const finish = async () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    saveIndex()
  } finally {
    await stopRuntime?.()
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    run.interrupted = signal
    void finish().finally(() => process.exit(130))
  })

const call = (method, params = {}, budget) => runtime.client.call(method, params, budget)
const params = () => ({ managerId: manager.id })
const board = async () => (await call('litch/manager/board/read', params())).board
async function readThread(threadId) {
  return (await call('thread/read', { threadId, includeTurns: true })).thread
}

async function sample() {
  const current = await board()
  for (const line of current.lines) lines.set(line.threadId, line)
  run.maxRunningLines = Math.max(
    run.maxRunningLines,
    current.lines.filter((line) => line.running).length,
  )
  // 回合通知弥补看板轮询之间短回合的峰值；只有确认属于经理树的线程才计入。
  const active = new Set()
  for (const frame of runtime.client.frames) {
    const id = frame.params?.threadId
    if (!lines.has(id)) continue
    if (frame.method === 'turn/started') active.add(id)
    if (frame.method === 'turn/completed') active.delete(id)
    run.maxRunningLines = Math.max(run.maxRunningLines, active.size)
  }
  return current
}

async function settle(deadline, expected) {
  let quietSince = null
  while (Date.now() < deadline) {
    const current = await sample()
    const thread = await readThread(manager.threadId)
    const turns = thread.turns ?? []
    const done = expected
      ? turns.some(
          (turn) =>
            (turn.id === expected ||
              turn.items.some(
                (item) =>
                  item.type === 'userMessage' && itemText(item).includes(`kind="${expected}"`),
              )) &&
            turn.status !== 'inProgress',
        )
      : true
    const busy =
      current.lines.some((line) => line.running) ||
      turns.some((turn) => turn.status === 'inProgress') ||
      thread.status?.type === 'active' ||
      thread.litchQueuedNotes?.length
    if (done && !busy) {
      quietSince ??= Date.now()
      // 给设备回报队列一个完整安静窗口，不能只看到线 idle 就立刻进入下一步。
      if (Date.now() - quietSince >= 1500) return
    } else quietSince = null
    await delay(150)
  }
  throw new Error(`步骤等待超时（${timeout / 1000} 秒），等待 ${expected ?? '经理与工作线安静'}`)
}

async function say(text, step, deadline, fixture = false) {
  if (fixture) step.notes.push(`假模型专用触发输入：${text}`)
  const { turn } = await call(
    'turn/start',
    { threadId: manager.threadId, input: [{ type: 'text', text, text_elements: [] }] },
    Math.max(1, deadline - Date.now()),
  )
  await settle(deadline, turn.id)
  return (await readThread(manager.threadId)).turns.find((entry) => entry.id === turn.id)
}
async function trigger(operation, args, step, deadline, namespace = '经理') {
  if (options.fake) {
    const turn = await say(
      `${namespace}：${operation} ${JSON.stringify(args)}`,
      step,
      deadline,
      true,
    )
    const invoked = turn.items.find(
      (item) => item.type === 'dynamicToolCall' && item.tool === operation,
    )
    if (invoked?.status !== 'completed' || invoked.success === false) {
      throw new Error(
        `夹具工具链未完成：${namespace}.${operation}；${turn.items.map(itemText).join('\n')}`,
      )
    }
  }
}

async function interruptRunning(step) {
  for (const threadId of [manager?.threadId, ...lines.keys()].filter(Boolean)) {
    try {
      const thread = await readThread(threadId)
      for (const turn of thread.turns ?? [])
        if (turn.status === 'inProgress') {
          await call('turn/interrupt', { threadId, turnId: turn.id }, 5000)
          step.notes.push(`超时收场：打断 ${threadId}/${turn.id}`)
        }
    } catch (error) {
      step.errors.push(`打断失败：${error.message}`)
    }
  }
}

async function snapshot(step) {
  if (!manager) return
  step.board = await sample()
  step.changes = boardChanges(lastBoard, step.board)
  step.newLines = step.board.lines.filter(
    (line) => !lastBoard?.lines.some((old) => old.threadId === line.threadId),
  )
  const thread = await readThread(manager.threadId)
  step.managerThread = thread
  step.turns = writer.clean(
    (thread.turns ?? [])
      .filter((turn) => !seenTurns.has(turn.id) || turn.status === 'inProgress')
      .map((turn) => turnEvidence(turn, runtime.client.frames, manager.threadId)),
  )
  for (const turn of step.turns) if (turn.status !== 'inProgress') seenTurns.add(turn.id)
  for (const turn of step.turns)
    if (turn.status === 'failed') {
      step.errors.push(`经理回合失败：${turn.id}；${JSON.stringify(turn.error)}`)
      step.status = 'error'
    }
  step.tree = [
    { threadId: thread.id, cwd: thread.cwd, status: thread.status, role: 'manager' },
    ...step.board.lines,
  ]
  step.gitAfter = repositoryEvidence(runtime.cwd, runtime.env)
  lastBoard = step.board
  for (const line of lines.values()) {
    try {
      const child = await readThread(line.threadId)
      const turns = writer.clean(
        (child.turns ?? []).map((turn) => turnEvidence(turn, runtime.client.frames, line.threadId)),
      )
      writer.write(`lines/${line.threadId}.json`, { ...line, thread: child, turns })
      writer.write(`lines/${line.threadId}.md`, transcriptMarkdown(turns))
    } catch (error) {
      step.errors.push(`线 ${line.threadId} 取证失败：${error.message}`)
    }
  }
}

async function step(number, title, input, action) {
  const started = Date.now()
  const record = { number, title, input, status: 'completed', notes: [], errors: [], turns: [] }
  steps.push(record)
  console.log(`${number}/9 ${title}`)
  try {
    record.gitBefore = repositoryEvidence(runtime.cwd, runtime.env)
  } catch (error) {
    record.errors.push(`步骤前 git 取证失败：${error.message}`)
  }
  try {
    await action(record, started + timeout)
    if (manager) await settle(started + timeout)
  } catch (error) {
    record.status = /超时/.test(error.message) ? 'timeout' : 'error'
    record.errors.push(error.message)
    await interruptRunning(record)
  }
  try {
    await snapshot(record)
  } catch (error) {
    record.errors.push(`取证失败：${error.message}`)
    record.status = 'error'
  }
  record.elapsedMs = Date.now() - started
  if (record.errors.length && record.status === 'completed') record.status = 'error'
  const prefix = `steps/${String(number).padStart(2, '0')}`
  writer.write(`${prefix}/step.json`, record)
  writer.write(`${prefix}/manager.md`, transcriptMarkdown(record.turns))
  writer.write(`${prefix}/board.json`, record.board ?? null)
  writer.write(`${prefix}/tree.json`, record.tree ?? [])
  writer.write(`${prefix}/git.json`, {
    before: record.gitBefore,
    after: record.gitAfter,
    externalCommit: record.externalCommit,
  })
  saveIndex()
}

try {
  runtime = await startRuntime(options, writer, (stop) => {
    stopRuntime = stop
  })
  const initialTests = createTodo(runtime.cwd, runtime.env)
  writer.write('initial-tests.json', initialTests)
  run.initialTestsExitCode = initialTests.status
  run.sandbox = runtime.cwd
  run.sourceCommit = git(fileURLRepo(), runtime.env, 'rev-parse', 'HEAD')
  writer.write(
    'sandbox-initial.json',
    Object.fromEntries(
      readdirSync(runtime.cwd)
        .filter((name) => name !== '.git')
        .map((name) => [name, readFileSync(join(runtime.cwd, name), 'utf8')]),
    ),
  )
  const dispatch = {
    harness: null,
    model: null,
    effort: null,
    worktree: true,
    merge: 'manager',
    maxRunningLines: 2,
  }
  await step(1, '建经理', 'manager-open；第一件事留空', async (record, deadline) => {
    const created = await call('litch/manager/create', {
      cwd: runtime.cwd,
      harness: 'claude-code',
      model: runtime.model,
      effort: null,
      name: 'todo-lite 0.2 经理',
      scope: '把 todo-lite 做到 0.2：修掉已知 bug、加导出功能',
      template: 'release',
      dispatch,
      contact: { desktopNotification: false, unanswered: 'wait' },
      rules:
        '子会话跟经理一样；改代码用工作树；同时最多 2 条线。只操作本次沙箱仓库，不联网、不推送、不发布。',
      firstTask: '',
    })
    manager = created.manager
    record.createResponse = created
    await settle(deadline, 'manager-open')
    await trigger(
      'add',
      decisionFixture(
        '导出采用什么格式？',
        '0.2 计划加导出，README 尚未确定 CSV 或 JSON，需要用户选择。',
      ),
      record,
      deadline,
    )
    await trigger(
      'add',
      {
        kind: 'item',
        item: {
          title: '修复越界删除并增加导出',
          basis: [{ kind: 'file', target: 'README.md', label: '0.2 路线图' }],
        },
      },
      record,
      deadline,
    )
  })
  await step(2, '顺口问单测数', '现在一共有几个单测？', (record, deadline) =>
    say(record.input, record, deadline),
  )
  await step(3, '范围外要求', '顺便把它整个用 Rust 重写吧。', async (record, deadline) => {
    await say(record.input, record, deadline)
    await trigger(
      'add',
      {
        ...decisionFixture(
          '是否把 Rust 重写纳入范围？',
          '用户新增 Rust 重写要求，超出现有 0.2 范围。',
        ),
        decision: {
          title: '是否把 Rust 重写纳入范围？',
          background: '用户新增 Rust 重写要求，超出现有 0.2 范围。',
          options: [
            { id: 'later', label: '暂不重写', description: '先完成 Node 0.2。' },
            { id: 'now', label: '现在重写', description: '调整范围和交付时间。' },
          ],
          recommend: 'later',
          default: { kind: 'ask' },
          basis: [{ kind: 'file', target: 'README.md', label: '路线图' }],
        },
      },
      record,
      deadline,
    )
  })
  await step(4, '对话里答导出格式', '导出用 JSON 吧，其他按你的计划开始。', async (record, deadline) => {
    const before = await board()
    record.notes.push(
      `发送前决策标题：${before.decisions.map((entry) => `${entry.id} ${entry.title}`).join('；') || '无'}。是否曾提出导出格式决策由读者核对。`,
    )
    await say(record.input, record, deadline)
    if (options.fake) {
      const decision = before.decisions.find((entry) => entry.title === '导出采用什么格式？')
      if (decision)
        await trigger(
          'answer',
          { id: decision.id, optionId: 'json', text: record.input },
          record,
          deadline,
        )
      await trigger(
        'start',
        {
          title: '夹具工作线',
          prompt:
            '这是 todo-lite 0.2 的隔离驱动验收；本条线仅验证工具、工作树和回报收集，不实现产品功能，不联网、不推送。请写个文件，随后如实报告执行结果。\n没验：真实模型的角色表现。',
          background:
            '经理正在隔离的 todo-lite 仓库验证九步剧本。用户已经选择 JSON，现需验证工作线可以继承供应商和模型、使用独立工作树，并把回报交还经理；不修改真实项目或用户配置。',
          initiation: 'user_asked',
          kind: 'fresh',
        },
        record,
        deadline,
        '会话',
      )
    }
  })
  await step(5, '等待线回报', '等待设备注入工作线回报事件', async (record, deadline) => {
    await settle(deadline)
    if (options.fake) {
      const line = (await board()).lines[0]
      if (line)
        await trigger(
          'send',
          { thread_id: line.threadId, message: '跑个命令，验证沙箱中的命令审批并回报。' },
          record,
          deadline,
          '会话',
        )
    }
    const current = await board()
    record.notes.push(
      current.lines.length
        ? `线 ${current.lines.length} 条；已有回报 ${current.lines.filter((line) => line.report).length} 条。之前步骤若已收回报，回报回合保留在当时步骤。`
        : '经理没有开线；本步没有回报事件可等待。',
    )
  })
  await step(6, '看板答复', '首项待定决策选推荐，附“按推荐办”', async (record, deadline) => {
    const decision = (await board()).decisions.find((entry) => entry.status === 'open')
    if (!decision) {
      record.status = 'skipped'
      record.notes.push('看板无待定决策，未发送 answers/submit。')
      return
    }
    record.submittedAnswer = {
      decisionId: decision.id,
      revision: decision.revision,
      optionId: decision.recommend,
      text: '按推荐办',
    }
    record.answerResponse = await call('litch/manager/answers/submit', {
      ...params(),
      answers: [record.submittedAnswer],
    })
    record.notes.push(
      `已提交 ${decision.id}，推荐=${decision.recommend ?? '无推荐，只提交自由文字'}`,
    )
    if (record.answerResponse.rejected.length)
      throw new Error(`看板答复被拒绝：${JSON.stringify(record.answerResponse.rejected)}`)
    if (
      record.answerResponse.accepted.length !== 1 ||
      record.answerResponse.accepted[0].id !== decision.id ||
      record.answerResponse.delivery !== 'queued'
    )
      throw new Error('看板答复未确认接收本次决策并排入事件队列')
    await settle(deadline, 'manager-answers')
  })
  await step(7, '仓库外部变化', '我刚改了路线图，你看下现在情况。', async (record, deadline) => {
    const readme = join(runtime.cwd, 'README.md')
    const prior = readFileSync(readme, 'utf8')
    writeFileSync(
      readme,
      `${prior}\n## 最新路线图（用户外部更新）\n\n0.2 仅修复已知 bug；导出功能推迟到 0.3。以上述最新安排为准。\n`,
    )
    git(runtime.cwd, runtime.env, 'add', 'README.md')
    git(
      runtime.cwd,
      runtime.env,
      '-c',
      'user.name=song',
      '-c',
      'user.email=slovx2@gmail.com',
      'commit',
      '--only',
      'README.md',
      '-m',
      '用户外部更新：导出推迟到 0.3',
    )
    record.externalCommit = git(runtime.cwd, runtime.env, 'rev-parse', 'HEAD')
    await say(record.input, record, deadline)
    await trigger(
      'update',
      {
        kind: 'item',
        id: 'I-1',
        patch: { why: 'README 已把导出推迟到 0.3' },
        why: '按外部路线图核对事项',
      },
      record,
      deadline,
    )
    await trigger(
      'close',
      {
        kind: 'item',
        id: 'I-1',
        status: 'deferred',
        reason: '外部路线图把导出推迟到 0.3；夹具仅验证关闭操作。',
      },
      record,
      deadline,
    )
  })
  await step(8, '改规矩', 'update：同时最多 1 条线；合并前先问我', async (record, deadline) => {
    record.updateResponse = await call('litch/manager/update', {
      ...params(),
      dispatch: { ...dispatch, maxRunningLines: 1 },
      rules:
        '子会话跟经理一样；改代码用工作树；同时最多 1 条线。只操作本次沙箱仓库，不联网、不推送、不发布。合并前先问我。',
    })
    await settle(deadline, 'manager-rules')
  })
  await step(9, '结束经理', 'end → manager-end → ended', async (record, deadline) => {
    record.endResponse = await call('litch/manager/end', params())
    await settle(deadline, 'manager-end')
    while (Date.now() < deadline) {
      const current = (await call('litch/manager/list')).managers.find(
        (entry) => entry.id === manager.id,
      )
      if (current?.status === 'ended') {
        record.finalManager = current
        return
      }
      await delay(150)
    }
    throw new Error('等待经理 ended 超时')
  })
  run.finalStatus = steps.at(-1)?.finalManager?.status ?? 'unknown'
  if (options.fake) {
    const turns = steps.flatMap((record) => record.turns)
    const tools = turns.flatMap((turn) => turn.tools.map((tool) => tool.name))
    const answerStep = steps.find((record) => record.number === 6)
    const submitted = answerStep?.submittedAnswer
    const saved = answerStep?.board?.decisions.find(
      (decision) => decision.id === submitted?.decisionId,
    )
    const endStep = steps.find((record) => record.number === 9)
    run.fixtureCoverage = {
      nineSteps: steps.length === 9,
      allStepsCompleted: steps.every((record) => record.status === 'completed'),
      managerEvents: Object.fromEntries(
        ['manager-open', 'manager-answers', 'manager-rules', 'manager-end'].map((kind) => [
          kind,
          turns.some((turn) => turn.input.includes(`kind="${kind}"`)),
        ]),
      ),
      tools: Object.fromEntries(
        ['add', 'answer', 'update', 'close'].map((name) => [
          name,
          tools.includes(`litch_manager.${name}`),
        ]),
      ),
      // 校验协议事实：不能只见过事件就算答复落库，也不能只检查最终 ended。
      boardAnswerPersisted: Boolean(
        submitted &&
          saved?.status === 'answered' &&
          saved.answer?.by === 'user' &&
          saved.answer.optionId === submitted.optionId &&
          saved.answer.text === submitted.text &&
          answerStep.answerResponse?.delivery === 'queued',
      ),
      endingThenEnded:
        endStep?.endResponse?.manager.status === 'ending' &&
        endStep?.finalManager?.status === 'ended',
      linesReported: [...lines.values()].some((line) => line.report?.text && !line.running),
      fileApproved: runtime.client.frames.some(
        (frame) =>
          frame.direction === 'approval' &&
          frame.method === 'item/fileChange/requestApproval' &&
          frame.result?.decision === 'accept',
      ),
      commandApproved: runtime.client.frames.some(
        (frame) =>
          frame.direction === 'approval' &&
          frame.method === 'item/commandExecution/requestApproval' &&
          frame.result?.decision === 'accept',
      ),
      ended: run.finalStatus === 'ended',
    }
    writer.write('fixture-coverage.json', run.fixtureCoverage)
    if (JSON.stringify(run.fixtureCoverage).includes(':false')) process.exitCode = 1
  }
  run.finishedAt = new Date().toISOString()
  run.errors = steps.flatMap((record) => record.errors)
  if (run.errors.length || run.finalStatus !== 'ended') process.exitCode = 1
  console.log(`证据：${output}`)
} catch (error) {
  run.fatal = writer.clean(error.message)
  console.error(run.fatal)
  process.exitCode = 1
} finally {
  await finish()
}

function fileURLRepo() {
  return new URL('../', import.meta.url)
}
