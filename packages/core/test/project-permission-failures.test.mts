import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROJECT_PERMISSION,
  type ProjectPermission,
} from '../../protocol/src/harness-project-permissions.mjs'
import {
  createProjectPermissions,
  type ProjectPermissionView,
} from '../src/device/project-permissions.mjs'
import {
  type ChannelErrorShape,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  createRpc,
  createTransportPair,
  keys,
  serveChannel,
} from '../src/index.mjs'
import { type Handler, serveFake } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

for (const fault of ['timeout', 'unsupported', 'offline'] as const) {
  test(`权限读取 ${fault}：经真实 RPC、通道和副本保留订阅，重试及重连可恢复`, async () => {
    const time = fakeClock()
    const [client, server] = createTransportPair()
    const handlers: Record<string, Handler> = {}
    const record: ProjectPermission = {
      cwd: '',
      harness: 'pi',
      permission: ':workspace',
      confirmedPermissions: [],
    }
    if (fault !== 'unsupported') handlers[PROJECT_PERMISSION.read] = () => undefined
    const fake = serveFake(server, handlers)
    let online = true
    let rpc = createRpc(client, {
      clock: time.clock,
      notification() {},
      close() {
        online = false
      },
    })
    const permissions = createProjectPermissions({
      deviceId: 'local',
      online: () => online,
      supported: () => true,
      request: async (method, params) => (await rpc.request(method, params)) as ProjectPermission,
    })
    const base = createMockCore({ clock: time.clock })
    const host: CoreHost = {
      ...base,
      subscribe(topic, sink) {
        return topic.kind === 'projectPermission'
          ? permissions.open(topic.cwd, topic.harness, sink)
          : base.subscribe(topic, sink)
      },
      async command(name, input, signal) {
        if (name === 'projectPermission.retry') {
          const params = input as { cwd: string; harness: string }
          return permissions.retry(params.cwd, params.harness)
        }
        return base.command(name, input, signal)
      },
    }
    const [ui, core] = createPortPair()
    const serving = serveChannel(core, host, { clock: time.clock })
    const channel = connectChannel(ui)
    const replica = createReplica(channel)
    const stop = replica.openProjectPermission('local', '', 'pi')
    await settle()
    if (fault === 'timeout') {
      time.advance(29_999)
      await settle()
      assert.equal(replica.store.get(keys.projectPermissionError('local', '', 'pi')), undefined)
      time.advance(1)
    } else if (fault === 'offline') fake.drop()
    await settle()
    const errorKey = keys.projectPermissionError('local', '', 'pi')
    const error = replica.store.get<ChannelErrorShape>(errorKey)
    assert.equal(error?.code, fault)
    assert.equal(
      error?.text?.key,
      `permission.project.${fault === 'unsupported' ? 'unavailable' : fault}`,
    )
    assert.doesNotMatch(JSON.stringify(error), /RpcAbortError|litch\/|30000/)
    assert.equal(
      replica.store.get<ProjectPermissionView>(keys.projectPermission('local', '', 'pi'))?.record,
      null,
    )
    if (fault === 'offline') {
      const [nextClient, nextServer] = createTransportPair()
      serveFake(nextServer, { [PROJECT_PERMISSION.read]: () => record })
      rpc = createRpc(nextClient, { clock: time.clock, notification() {}, close() {} })
      online = true
      permissions.resync()
    } else {
      handlers[PROJECT_PERMISSION.read] = () => record
      await channel.command('projectPermission.retry', {
        deviceId: 'local',
        cwd: '',
        harness: 'pi',
      })
    }
    await settle()
    assert.equal(replica.store.get(errorKey), undefined)
    assert.equal(
      replica.store.get<ProjectPermissionView>(keys.projectPermission('local', '', 'pi'))?.record
        ?.permission,
      ':workspace',
    )
    stop()
    rpc.close()
    channel.close()
    serving()
  })
}

for (const method of ['litch/projectPermission/read', PROJECT_PERMISSION.read]) {
  test(`${method}：无应答才等到默认 30 秒，未知方法和断线立即结束`, async () => {
    for (const failure of ['silent', 'unknown', 'closed']) {
      const time = fakeClock()
      const [client, server] = createTransportPair()
      const fake = serveFake(server, failure === 'unknown' ? {} : { [method]: () => undefined })
      const rpc = createRpc(client, { clock: time.clock, notification() {}, close() {} })
      const pending = assert.rejects(
        rpc.request(method, {}),
        failure === 'unknown'
          ? { code: -32601 }
          : { reason: failure === 'silent' ? 'timeout' : 'closed' },
      )
      await settle()
      if (failure === 'silent') time.advance(30_000)
      if (failure === 'closed') fake.drop()
      await pending
      assert.equal(time.pending(), 0)
      rpc.close()
    }
  })
}
