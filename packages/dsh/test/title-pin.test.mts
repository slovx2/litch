import assert from 'node:assert/strict'
import test from 'node:test'
import { type DshThread, Projection } from '../src/projection.mjs'

const thread = (preview: string): DshThread => ({
  id: 't1',
  cwd: '/w',
  name: null,
  preview,
  createdAt: 0,
  updatedAt: 0,
  model: null,
  effort: null,
  preset: 'workspace-write',
  parentThreadId: null,
  forkedFromId: null,
  ephemeral: false,
})

const title = (value: string, kind: string) => ({
  type: 'session/title',
  seq: 1,
  time: 0,
  data: { title: value, source: { kind } },
})

test('dsh 起标题之前有意给的名字（和头一句话不同）在第一个标题来时钉住，不被兜底或模型标题盖掉', () => {
  const pinned: string[] = []
  const notes: any[] = []
  const projection = new Projection(thread('[Litch] Another session on this device started you…'), {
    pin: (name) => pinned.push(name),
  })
  projection.wanted = '补快速上手'
  projection.apply(title('[Litch] Another session', 'fallback'), (method, params) =>
    notes.push([method, params]),
  )
  assert.equal(projection.thread.name, '补快速上手')
  assert.deepEqual(pinned, ['补快速上手'])
  assert.deepEqual(notes, [['thread/name/updated', { threadName: '补快速上手' }]])
  // 钉住之后 dsh 回来的用户标题照常认，之后的模型标题也不再走钉名这条路
  projection.apply(title('补快速上手', 'user'), () => {})
  assert.equal(projection.named, '补快速上手')
  assert.deepEqual(pinned, ['补快速上手'])
})

test('官方桌面端在首条消息前写回的消息原文只是临时名：模型标题照常替换，不钉', () => {
  const pinned: string[] = []
  const projection = new Projection(thread('看一下首页为什么慢'), {
    pin: (name) => pinned.push(name),
  })
  projection.wanted = '看一下首页为什么慢'
  projection.apply(title('首页性能排查', 'model'), () => {})
  assert.equal(projection.thread.name, '首页性能排查')
  assert.deepEqual(pinned, [])
})
