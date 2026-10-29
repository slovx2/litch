import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withAutomationPreview } from '../src/automation-preview/host.mjs'
import type {
  AutomationPreviewCommand,
  AutomationPreviewPort,
  AutomationPreviewView,
} from '../src/automation-preview/model.mjs'
import type { CoreHost, HostSink } from '../src/channel/server.mjs'

test('本机预览按来源会话隔离，最后一个消费者退出才停媒体', () => {
  let notify: Parameters<AutomationPreviewPort['listen']>[0] = () => {}
  const commands: AutomationPreviewCommand[] = []
  const host = withAutomationPreview(
    { command: async () => ({}), subscribe: () => () => {} } as CoreHost,
    {
      listen: (h) => {
        notify = h
      },
      command: async (c) => {
        commands.push(c)
      },
    },
  )
  const values: unknown[] = [],
    other: unknown[] = []
  const sink: HostSink = {
    snapshot: (value) => values.push(value),
    delta: () => {},
    error: () => {},
  }
  const one = host.subscribe(
    { kind: 'automationPreview', deviceId: 'remote', sessionId: 'a' },
    sink,
  )
  const two = host.subscribe(
    { kind: 'automationPreview', deviceId: 'remote', sessionId: 'a' },
    { ...sink },
  )
  host.subscribe(
    { kind: 'automationPreview', deviceId: 'remote', sessionId: 'b' },
    { ...sink, snapshot: (value) => other.push(value) },
  )
  const owner = { deviceId: 'remote', sessionId: 'a' }
  notify(
    {
      owner,
      app: 'Fixture',
      surface: null,
      pointer: null,
      frame: null,
      status: 'ready',
      foreground: false,
      pinned: false,
      updatedAt: 1,
    } as AutomationPreviewView,
    owner,
  )
  assert.equal(values.length, 4)
  assert.deepEqual(other, [null])
  one()
  assert.equal(commands.filter((c) => c.action === 'hide').length, 0)
  two()
  assert.equal(commands.filter((c) => c.action === 'hide').length, 1)
})
