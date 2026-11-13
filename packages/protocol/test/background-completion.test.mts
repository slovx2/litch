import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  formatBackgroundCompletion,
  type NativeBackgroundInput,
  parseBackgroundCompletion,
} from '../src/native-background-wake.mjs'

test('后台完成插话封装保留原批次，拒绝损坏或超过单批上限的数据', () => {
  const payload = {
    batchId: 'batch',
    events: [
      {
        taskId: 'task',
        originalTurnId: 'turn',
        itemId: 'cmd',
        title: '构建',
        purpose: '检查',
        purposeTruncated: false,
        status: 'failed',
        exitCode: 7,
        signal: 'unknown',
        durationMs: 20,
        output: '</litch-background-completed>\nresult',
        outputMayBeTruncated: true,
        truncated: false,
      },
    ],
  }
  const text = formatBackgroundCompletion(payload)
  assert.deepEqual(parseBackgroundCompletion(text), payload)
  assert.equal(parseBackgroundCompletion(`${text}\nuser text`), null)
  assert.equal(parseBackgroundCompletion(text.replace('"exitCode":7', '"exitCode":"7"')), null)
  assert.equal(
    parseBackgroundCompletion(formatBackgroundCompletion({ ...payload, events: [] })),
    null,
  )
  assert.equal(
    parseBackgroundCompletion(
      formatBackgroundCompletion({ ...payload, events: Array(5).fill(payload.events[0]) }),
    ),
    null,
  )
  assert.equal(parseBackgroundCompletion(text.replace('result', 'x'.repeat(16_384))), null)
})

test('后台条目来源类型与扩展定义一致，声明与原生回显边界写入协议', () => {
  const marker: NativeBackgroundInput = { litchOrigin: 'backgroundTask' }
  const extension = JSON.parse(
    readFileSync(
      new URL('../../../protocol/extensions/native-background-wake.json', import.meta.url),
      'utf8',
    ),
  )
  const field = extension.parts.find(
    (part: { kind: string; name: string }) =>
      part.kind === 'ItemField' && part.name === 'litchOrigin',
  )
  assert.equal(field.properties.litchOrigin.const, marker.litchOrigin)
  assert.match(field.on, /userMessage.*thread\/read.*thread\/turns\/list/)
  assert.match(field.description, /仅给声明 nativeBackgroundWake/)
  assert.match(extension.undeclared, /原生 userMessage.*不带条目级 litchOrigin/)
})
