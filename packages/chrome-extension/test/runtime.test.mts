import assert from 'node:assert/strict'
import test from 'node:test'
import { createExtensionRuntime } from '../src/index.mjs'

function event() {
  const listeners = new Set<(...args: any[]) => any>()
  return {
    listeners,
    addListener: (fn: (...args: any[]) => any) => listeners.add(fn),
    removeListener: (fn: (...args: any[]) => any) => listeners.delete(fn),
    emit: (...args: any[]) => [...listeners].map((fn) => fn(...args)),
  }
}
function fixture(id = 'a'.repeat(32), productName = 'Example', hostName = 'example.chrome') {
  const events = Array.from({ length: 9 }, event)
  const [clicked, installed, startup, message, removed, updated, committed, detached, debug] =
    events
  const local: Record<string, any> = {},
    session: Record<string, any> = {}
  const storage = (values: Record<string, any>) => ({
    get: async (_keys: unknown) => structuredClone(values),
    set: async (next: object) => {
      Object.assign(values, next)
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    },
  })
  const sent: any[] = [],
    hosts: string[] = [],
    titles: string[] = []
  const ports: any[] = []
  const chrome = {
    action: {
      onClicked: clicked,
      setBadgeText: async () => {},
      setTitle: async (value: any) => {
        titles.push(value.title)
      },
    },
    runtime: {
      id,
      onInstalled: installed,
      onStartup: startup,
      onMessage: message,
      getManifest: () => ({ version: '0.34.1' }),
      connectNative: (host: string) => {
        hosts.push(host)
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          postMessage: (value: any) => sent.push(value),
          disconnect: () => port.onDisconnect.emit(),
        }
        ports.push(port)
        return port
      },
    },
    management: { getSelf: async () => ({ installType: 'development' }) },
    i18n: { getUILanguage: () => 'en-US' },
    storage: { local: storage(local), session: storage(session) },
    tabs: { onRemoved: removed, onUpdated: updated },
    webNavigation: { onCommitted: committed },
    debugger: { onDetach: detached, onEvent: debug, detach: async () => {} },
  }
  const options = {
    chrome,
    identity: { hostName, extensionIds: [id], productName },
    protocol: { min: 1, max: 1 },
    storagePrefix: 'fixture',
    pointerSource: '',
  }
  return { events, hosts, local, session, sent, ports, options, titles }
}

test('导入与创建无副作用；显式启动只连自己的 host，停止只撤自己的监听', async () => {
  const f = fixture()
  const unrelated = () => {}
  f.events[0]!.addListener(unrelated)
  const runtime = createExtensionRuntime(f.options)
  assert.deepEqual(f.hosts, [])
  await Promise.all([runtime.start(), runtime.start()])
  assert.deepEqual(f.hosts, ['example.chrome'])
  assert.equal(f.sent[0].protocol, 1)
  assert.equal(f.sent[0].minProtocol, 1)
  assert.equal(f.events[0]!.listeners.size, 2)
  await runtime.stop()
  assert.equal(f.ports[0].onMessage.listeners.size, 0)
  assert.equal(f.ports[0].onDisconnect.listeners.size, 0)
  assert.deepEqual([...f.events[0]!.listeners], [unrelated])
  assert.ok(f.events.slice(1).every((event) => event.listeners.size === 0))
  await runtime.start()
  assert.equal(f.hosts.length, 2)
  await runtime.stop()
})

test('断链撤掉旧 port 监听，停止后不重连', async () => {
  const f = fixture()
  const runtime = createExtensionRuntime(f.options)
  await runtime.start()
  f.ports[0].disconnect()
  assert.equal(f.ports[0].onMessage.listeners.size, 0)
  assert.equal(f.ports[0].onDisconnect.listeners.size, 0)
  await runtime.stop()
  assert.equal(f.hosts.length, 1)
})

test('两个身份并存，协议不变，产品展示和持久状态各自独立', async () => {
  const a = fixture(),
    b = fixture('b'.repeat(32), 'Other App', 'other.chrome')
  const first = createExtensionRuntime(a.options),
    second = createExtensionRuntime(b.options)
  await first.start()
  await second.start()
  a.ports[0].onMessage.emit({
    kind: 'welcome',
    protocol: 1,
    incompatible: null,
    litchVersion: '0.34.1',
  })
  b.ports[0].onMessage.emit({
    kind: 'welcome',
    protocol: 1,
    incompatible: null,
    litchVersion: '0.34.1',
  })
  await Promise.resolve()
  assert.deepEqual(a.hosts, ['example.chrome'])
  assert.deepEqual(b.hosts, ['other.chrome'])
  assert.notEqual(a.local.fixtureInstanceId, b.local.fixtureInstanceId)
  assert.match(b.titles.at(-1)!, /^Other App/)
  await first.stop()
  assert.ok(b.events.every((event) => event.listeners.size === 1))
  await second.stop()
})

test('错误 ID 与未实现的协议拒绝，初始化中停止不会留下定时器或原生连接', async () => {
  const f = fixture()
  assert.throws(() => createExtensionRuntime({ ...f.options, protocol: { min: 2, max: 2 } }))
  const wrong = createExtensionRuntime({
    ...f.options,
    identity: { ...f.options.identity, extensionIds: ['b'.repeat(32)] },
  })
  await assert.rejects(wrong.start(), /identity/)
  const runtime = createExtensionRuntime(f.options)
  const start = runtime.start()
  await runtime.stop()
  await start
  assert.deepEqual(f.hosts, [])
  assert.ok(f.events.every((event) => event.listeners.size === 0))
})
