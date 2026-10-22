// 回合末尾“正在工作”那一行：回合在跑时一直在，只在正文出字、等人答复时让开。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentMessageItem, CommandItem, ItemView, ToolCallItem } from '../src/index.mjs'
import { workingShown } from '../src/index.mjs'

const user: ItemView = { id: 'u', kind: 'userMessage', text: 'hi', attachments: [] }

const message = (status: AgentMessageItem['status'], text: string): AgentMessageItem => ({
  id: 'm',
  kind: 'agentMessage',
  text,
  phase: 'unknown',
  status,
})

const command = (status: CommandItem['status']): CommandItem => ({
  id: 'c',
  kind: 'command',
  command: 'ls',
  cwd: '/',
  output: '',
  elided: null,
  exitCode: null,
  durationMs: null,
  startedAt: null,
  status,
})

const tool = (status: ToolCallItem['status'], extra: Partial<ToolCallItem> = {}): ToolCallItem => ({
  id: 't',
  kind: 'toolCall',
  source: null,
  tool: 'read',
  input: [],
  output: [],
  error: null,
  durationMs: null,
  status,
  ...extra,
})

test('回合不在跑：不显示', () => {
  assert.equal(workingShown(false, [user], 0), false)
})

test('空档里显示：等第一个字、两段输出之间、工具跑完之后', () => {
  assert.equal(workingShown(true, [user], 0), true)
  assert.equal(workingShown(true, [user, message('completed', '先看看')], 0), true)
  assert.equal(
    workingShown(true, [user, command('completed'), message('completed', '好')], 0),
    true,
  )
  // 还没出字的助手消息不算在写
  assert.equal(workingShown(true, [user, message('inProgress', '')], 0), true)
  // 取不到的条目跳过
  assert.equal(workingShown(true, [user, undefined], 0), true)
})

test('正文正在出字：不显示，光标已经表示在工作', () => {
  assert.equal(workingShown(true, [user, message('inProgress', '正在写')], 0), false)
})

test('命令、工具、思考在跑：照样显示，步骤来去不让它闪', () => {
  assert.equal(workingShown(true, [user, command('inProgress')], 0), true)
  assert.equal(workingShown(true, [user, tool('inProgress')], 0), true)
  const thinking: ItemView = { id: 'r', kind: 'reasoning', text: '在想', status: 'inProgress' }
  assert.equal(workingShown(true, [user, thinking], 0), true)
  assert.equal(
    workingShown(true, [user, message('completed', '先看看'), command('inProgress')], 0),
    true,
  )
  const wrapUp = tool('inProgress', { wrapUp: { suggestions: [] } })
  assert.equal(workingShown(true, [user, message('completed', '做完了'), wrapUp], 0), true)
})

test('步骤在跑、正文也在出字：不显示', () => {
  assert.equal(
    workingShown(true, [user, command('inProgress'), message('inProgress', '正在写')], 0),
    false,
  )
})

test('有待答的审批或提问：不显示', () => {
  assert.equal(workingShown(true, [user, command('completed')], 1), false)
})
