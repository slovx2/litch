import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import {
  codexHarness,
  countDiffLines,
  harnessFromRuntimeInfo,
  pathTwin,
  projectItem,
  projectSummary,
  projectThread,
  projectTurn,
  projectWorkspaces,
  resolveWorkspace,
  sessionStatus,
  threadTitle,
} from '../src/index.mjs'
import { agentText, project, thread, turn, userText } from './fixtures.mjs'

test('条目：用户消息把文字拼起来，别的输入变成附件', () => {
  const item = projectItem({
    type: 'userMessage',
    id: 'u',
    clientId: null,
    content: [
      { type: 'text', text: '看这张图', text_elements: [] },
      { type: 'localImage', path: '/tmp/shots/a.png' },
      { type: 'mention', name: 'serve.go', path: '/work/serve.go' },
      { type: 'text', text: '第二段', text_elements: [] },
    ],
  })
  assert.deepEqual(item, {
    id: 'u',
    kind: 'userMessage',
    text: '看这张图\n第二段',
    attachments: [
      { kind: 'image', label: 'a.png' },
      { kind: 'file', label: 'serve.go' },
    ],
  })
})

test('条目：助手消息的阶段，没标就是 unknown；是否还在出字由所在回合决定', () => {
  assert.deepEqual(projectItem(agentText('a', '好', 'final_answer')), {
    id: 'a',
    kind: 'agentMessage',
    text: '好',
    phase: 'final',
    status: 'completed',
  })
  const open = projectItem(agentText('a', '好'), true)
  assert.ok(
    open.kind === 'agentMessage' && open.phase === 'unknown' && open.status === 'inProgress',
  )
})

test('条目：命令和文件改动原样保留输出与补丁，并数出增删行数', () => {
  const command = projectItem({
    type: 'commandExecution',
    id: 'c',
    pluginId: null,
    scriptPath: null,
    command: 'go test ./...',
    cwd: '/work/app',
    processId: null,
    source: 'agent',
    status: 'failed',
    commandActions: [],
    aggregatedOutput: 'FAIL\n',
    exitCode: 1,
    durationMs: 1200,
  })
  assert.ok(command.kind === 'command' && command.output === 'FAIL\n' && command.exitCode === 1)
  assert.equal(command.status, 'failed')

  const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n'
  assert.deepEqual(countDiffLines(diff), { added: 2, removed: 1 })
  const change = projectItem({
    type: 'fileChange',
    id: 'f',
    status: 'completed',
    changes: [
      { path: 'x', kind: { type: 'update', move_path: 'y' }, diff },
      { path: 'z', kind: { type: 'delete' }, diff: '整个文件\n两行\n' },
    ],
  })
  assert.ok(change.kind === 'fileChange')
  assert.deepEqual(
    change.changes.map(({ diff: _diff, ...rest }) => rest),
    [
      {
        path: 'x',
        change: 'update',
        movedTo: 'y',
        added: 2,
        removed: 1,
        diffKind: 'patch',
        elided: null,
      },
      {
        path: 'z',
        change: 'delete',
        movedTo: null,
        added: 0,
        removed: 2,
        diffKind: 'content',
        elided: null,
      },
    ],
  )
  assert.equal(change.changes[0]?.diff, diff)
})

test('条目：工具调用取出参数和文本结果', () => {
  const item = projectItem({
    type: 'mcpToolCall',
    id: 'm',
    server: 'docs',
    tool: 'search',
    status: 'completed',
    arguments: { q: 'socket' },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: { content: [{ type: 'text', text: '三条结果' }], structuredContent: null, _meta: null },
    error: null,
    durationMs: 40,
  })
  assert.deepEqual(item, {
    id: 'm',
    kind: 'toolCall',
    source: 'docs',
    tool: 'search',
    input: [{ kind: 'text', text: '{\n  "q": "socket"\n}' }],
    output: [{ kind: 'text', text: '三条结果' }],
    error: null,
    durationMs: 40,
    status: 'completed',
  })
})

test('条目：不认识的类型变成一行说明，不抛错', () => {
  const item = projectItem({ type: 'holoDeck', id: 'h', power: 9 } as unknown as ThreadItem)
  assert.deepEqual(item, {
    id: 'h',
    kind: 'notice',
    label: { key: 'notice.unknownItem', args: { type: 'holoDeck' } },
    detail: null,
  })
  assert.equal(projectItem({ type: 'contextCompaction', id: 'k' }).kind, 'notice')
})

test('会话：标题、状态、时间单位', () => {
  assert.equal(threadTitle({ name: ' 起过的名字 ', preview: 'x' }), '起过的名字')
  assert.equal(threadTitle({ name: null, preview: '\n  第一行\n第二行' }), '第一行')
  assert.deepEqual(threadTitle({ name: null, preview: '' }), { key: 'session.untitled' })
  assert.equal(
    Array.from(threadTitle({ name: null, preview: '长'.repeat(200) }) as string).length,
    81,
  )

  assert.deepEqual(sessionStatus({ type: 'active', activeFlags: [] }), {
    status: 'running',
    waitingFor: null,
  })
  assert.deepEqual(sessionStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), {
    status: 'waiting',
    waitingFor: 'approval',
  })
  assert.equal(sessionStatus({ type: 'systemError' }).status, 'error')
  assert.equal(sessionStatus({ type: 'notLoaded' }).status, 'idle')

  const summary = projectSummary(thread({ id: 't', updatedAt: 1_700_000_500, preview: '你好' }), {
    harness: 'pi',
    workspaceId: 'w',
  })
  assert.equal(summary.updatedAt, 1_700_000_500_000)
  assert.equal(summary.title, '你好')
})

test('会话：回合和条目的顺序不变，条目标识带上回合，不同回合里同名的条目不会撞', () => {
  const view = projectThread(
    thread({
      id: 't',
      turns: [
        turn('t1', [userText('1', '问'), agentText('2', '答', 'final_answer')]),
        turn('t2', [userText('1', '再问'), agentText('2', '在答')], {
          status: 'inProgress',
          durationMs: null,
        }),
        turn('t3', [userText('1', '第三次')], {
          status: 'failed',
          error: {
            message: '额度用完了',
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
          },
        }),
      ],
    }),
    { deviceId: 'd', harness: 'pi' },
  )
  assert.deepEqual(
    view.turns.map((entry) => [entry.id, entry.status, entry.itemIds]),
    [
      ['t1', 'completed', ['t1:1', 't1:2']],
      ['t2', 'running', ['t2:1', 't2:2']],
      ['t3', 'failed', ['t3:1']],
    ],
  )
  assert.equal(view.turns[0]?.startedAt, 1_700_000_100_000)
  // 有的入口把开始时间填成了毫秒，也要认
  assert.equal(
    projectTurn(turn('t9', [], { startedAt: 1_700_000_100_123 })).turn.startedAt,
    1_700_000_100_123,
  )
  assert.equal(view.turns[2]?.error, '额度用完了')
  assert.equal(Object.keys(view.items).length, 5)
  const streaming = view.items['t2:2']
  assert.ok(streaming?.kind === 'agentMessage' && streaming.status === 'inProgress')
  const done = view.items['t1:2']
  assert.ok(done?.kind === 'agentMessage' && done.status === 'completed')
})

test('工作区：显式归属优先，其次按目录匹配取最深的，都不中就不归属', () => {
  const workspaces = projectWorkspaces([
    project('deep', 'api', '/work/app/services/api', 1),
    project('app', 'app', '/work/app/', 0),
  ])
  assert.deepEqual(
    workspaces.map((workspace) => workspace.id),
    ['app', 'deep'],
  )
  const at = (cwd: string, projectId: string | null = null) =>
    resolveWorkspace({ cwd, projectId }, workspaces)
  assert.equal(at('/elsewhere', 'deep'), 'deep')
  assert.equal(at('/work/app'), 'app')
  assert.equal(at('/work/app/web/src'), 'app')
  assert.equal(at('/work/app/services/api/handlers'), 'deep')
  assert.equal(at('/work/application'), null, '只在目录边界上算上级')
  assert.equal(at('/work/app', 'deleted-project'), 'app', '记着的工作区不在了，退回按目录匹配')
  assert.equal(at('/tmp'), null)
})

test('工作区：同一个目录是几个工作区的根时，只有一个根的优先，其次是主目录，再其次按排的先后', () => {
  const withRoots = (id: string, roots: string[], position: number) => ({
    ...project(id, id, roots[0] ?? '', position),
    roots: roots.map((path) => ({ path })),
  })
  // 照用户机器上从 Codex 导入的那几个：home 这个目录同时在三个工作区里，单目录的 home 排在最后
  const workspaces = projectWorkspaces([
    withRoots('tales', ['/u/Tales', '/w/games', '/w/home'], 0),
    withRoots('games', ['/w/games', '/w/home'], 1),
    withRoots('home', ['/w/home'], 2),
  ])
  const at = (cwd: string) => resolveWorkspace({ cwd, projectId: null }, workspaces)
  assert.equal(at('/w/home'), 'home')
  assert.equal(at('/w/home/sub'), 'home')
  // games 只在两个多目录的工作区里：它是 games 的主目录，不是 tales 的
  assert.equal(at('/w/games'), 'games')
  assert.equal(at('/u/Tales'), 'tales')
  // 都是多目录、都不是主目录：按排的先后
  const tie = projectWorkspaces([
    withRoots('b', ['/x/b', '/x/shared'], 1),
    withRoots('a', ['/x/a', '/x/shared'], 0),
  ])
  assert.equal(resolveWorkspace({ cwd: '/x/shared', projectId: null }, tie), 'a')
  // 深的照样先于这些规则：子目录自己是单目录工作区的根时归它
  const deep = projectWorkspaces([
    withRoots('one', ['/y'], 0),
    withRoots('many', ['/y/deep', '/z'], 1),
  ])
  assert.equal(resolveWorkspace({ cwd: '/y/deep/x', projectId: null }, deep), 'many')
})

test('工作区：macOS 上会话的工作目录是根的另一种写法（/private/tmp 和 /tmp）也归进去；Linux 上不认', () => {
  const workspaces = projectWorkspaces([
    project('tri', 'tri', '/tmp/w/tri', 0),
    project('real', 'real', '/private/var/folders/x/app', 1),
  ])
  const at = (cwd: string, os: string | null) =>
    resolveWorkspace({ cwd, projectId: null }, workspaces, pathTwin(os))
  assert.equal(at('/private/tmp/w/tri', 'macos'), 'tri')
  assert.equal(at('/private/tmp/w/tri/sub', 'macos'), 'tri')
  assert.equal(at('/var/folders/x/app/web', 'macos'), 'real')
  // 还不知道是什么系统：按 macOS 认
  assert.equal(at('/private/tmp/w/tri', null), 'tri')
  assert.equal(at('/private/tmp/w/trio', 'macos'), null, '只在目录边界上算上级')
  assert.equal(at('/private/tmp/w/tri', 'linux'), null)
  assert.equal(resolveWorkspace({ cwd: '/private/tmp/w/tri', projectId: null }, workspaces), null)
})

test('单 harness：认得 runtime/info 的是适配器的入口，不认得的按 codex', () => {
  const pi = harnessFromRuntimeInfo({
    engine: 'pi',
    protocolVersion: '0.157.1',
    cliBuild: '0.99.1',
    capabilities: [],
    releaseReady: true,
  })
  assert.deepEqual([pi.id, pi.name, pi.badge, pi.version], ['pi', 'Pi', 'PI', '0.99.1'])
  const claude = harnessFromRuntimeInfo({
    engine: 'claude-code',
    protocolVersion: '0.157.1',
    cliBuild: '2.1.282 (Claude Code)',
    capabilities: [],
    releaseReady: true,
  })
  assert.deepEqual([claude.id, claude.badge, claude.version], ['claude', 'CC', '2.1.282'])
  const codex = codexHarness({
    userAgent: 'codex_cli_rs/0.160.0 (Mac OS 15.5.0; arm64) unknown',
    codexHome: '/home/dev/.codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  })
  assert.deepEqual([codex.id, codex.badge, codex.version], ['codex', 'CX', '0.160.0'])
})
