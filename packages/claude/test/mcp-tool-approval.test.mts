import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvalRequest,
  mcpToolApprovalDecision,
  sessionGrantKey,
} from '../src/approval-request.mjs'

// MCP 工具调用的审批：请求是原生 codex 那种表单为空的征询（0.157.1 的 core/src/mcp_tool_call.rs），
// 对着真的 Claude Code 的那一遍在 native-mcp-tool-approval.test.mts。

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

const thread = {
  cwd: '/work',
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
} as const

test('MCP 工具的审批是带 codex_approval_kind 的空表单征询，参数按名字排好给人看', () => {
  const request = approvalRequest(
    permission('mcp__files__move', { to: '/b', from: '/a', force: true }),
    ids,
    { server: 'files', tool: 'move' },
  )
  assert.equal(request.method, 'mcpServer/elicitation/request')
  assert.deepEqual(request.params, {
    threadId: 'thread',
    turnId: 'turn',
    serverName: 'files',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: 'session',
      tool_params: { to: '/b', from: '/a', force: true },
      tool_params_display: [
        { name: 'force', value: true, display_name: 'force' },
        { name: 'from', value: '/a', display_name: 'from' },
        { name: 'to', value: '/b', display_name: 'to' },
      ],
    },
    message: '允许 MCP 服务 files 运行工具“move”吗？',
    requestedSchema: { type: 'object', properties: {} },
  })
  // 征询的形状上没有“拒绝并附说明”，声明了扩展的连接收到的也是这一份
  assert.deepEqual(request.paramsWithNote, request.params)
})

test('不是 MCP 工具的调用照旧：命令走命令审批，其余走文件改动审批', () => {
  assert.equal(
    approvalRequest(permission('Bash', { command: 'ls' }), ids, null).method,
    'item/commandExecution/requestApproval',
  )
  for (const name of ['Write', 'WebFetch', 'mcp__codex_harness_adapter__lookup'])
    assert.equal(
      approvalRequest(permission(name, {}), ids, null).method,
      'item/fileChange/requestApproval',
      name,
    )
})

test('MCP 工具审批的应答：接受、这个会话里都允许、拒绝、取消；认不出的算拒绝', () => {
  assert.equal(mcpToolApprovalDecision({ action: 'accept', content: {}, _meta: null }), 'accept')
  assert.equal(mcpToolApprovalDecision({ action: 'accept' }), 'accept')
  assert.equal(
    mcpToolApprovalDecision({ action: 'accept', content: {}, _meta: { persist: 'session' } }),
    'acceptForSession',
  )
  // “以后都允许”没有提供，客户端答了也只算这一次
  assert.equal(
    mcpToolApprovalDecision({ action: 'accept', content: {}, _meta: { persist: 'always' } }),
    'accept',
  )
  assert.equal(mcpToolApprovalDecision({ action: 'decline', content: null }), 'decline')
  assert.equal(mcpToolApprovalDecision({ action: 'cancel', content: null }), 'cancel')
  // 别的审批的答法、空的、乱写的，都不能当成放行
  for (const response of [{ decision: 'accept' }, { action: 'approve' }, {}, null, 'accept', []])
    assert.equal(mcpToolApprovalDecision(response), 'decline', JSON.stringify(response))
})

test('“这个会话里都允许”记的东西：MCP 工具按服务和工具记，不分参数；命令按原文记', () => {
  const move = { server: 'files', tool: 'move' }
  const key = sessionGrantKey(thread, permission('mcp__files__move', { from: '/a' }), move)
  assert.ok(key)
  assert.equal(sessionGrantKey(thread, permission('mcp__files__move', { from: '/z' }), move), key)
  // 别的工具、别的服务、换了审批档位或沙箱，都对不上
  for (const other of [
    sessionGrantKey(thread, permission('mcp__files__remove', {}), {
      server: 'files',
      tool: 'remove',
    }),
    sessionGrantKey(thread, permission('mcp__other__move', {}), { server: 'other', tool: 'move' }),
    sessionGrantKey({ ...thread, approvalPolicy: 'untrusted' }, permission('x', {}), move),
    sessionGrantKey({ ...thread, sandboxMode: 'read-only' }, permission('x', {}), move),
  ])
    assert.notEqual(other, key)

  const command = sessionGrantKey(thread, permission('Bash', { command: 'ls' }), null)
  assert.ok(command)
  assert.notEqual(sessionGrantKey(thread, permission('Bash', { command: 'ls -a' }), null), command)
  // 没有命令原文的调用（改文件等）没有可记的
  assert.equal(sessionGrantKey(thread, permission('Write', { file_path: '/a' }), null), null)
})
