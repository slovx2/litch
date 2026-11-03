import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROJECT_PERMISSION,
  type ProjectPermission,
} from '../../protocol/src/harness-project-permissions.mjs'
import type { HostSink } from '../src/channel/server.mjs'
import {
  createProjectPermissions,
  type ProjectPermissionView,
  projectPermissionChoice,
} from '../src/device/project-permissions.mjs'
import { newSessionSettings } from '../src/projection/settings.mjs'

test('能力变更后旧权限不支持：标记提示并使用引擎默认，不继续预填或阻断', () => {
  const options = {
    models: [],
    permissions: [
      {
        id: ':danger-full-access',
        title: null,
        note: null,
        risk: 'high' as const,
        confirm: false,
        switchable: false,
      },
    ],
    plan: false,
    modes: [],
  }
  const choice = projectPermissionChoice(':workspace', options)
  assert.deepEqual(choice, { permission: null, fallback: true })
  const selected = newSessionSettings(
    {},
    { model: null, effort: null, speed: null, permission: ':danger-full-access' },
    options,
  )
  assert.equal(selected.permission, ':danger-full-access')
  assert.deepEqual(projectPermissionChoice(':danger-full-access', options), {
    permission: ':danger-full-access',
    fallback: false,
  })
  assert.deepEqual(projectPermissionChoice(null, options), { permission: null, fallback: false })
})

test('项目订阅在变更时重新读取别名；晚到的读取不会覆盖新确认', async () => {
  const reads: ((record: ProjectPermission) => void)[] = []
  let online = true
  const permissions = createProjectPermissions({
    deviceId: 'device-a',
    online: () => online,
    supported: () => true,
    request: async () => new Promise<ProjectPermission>((resolve) => reads.push(resolve)),
  })
  const snapshots: ProjectPermissionView[] = []
  const sink: HostSink = {
    snapshot: (value) => snapshots.push(value as ProjectPermissionView),
    delta() {},
    error(error) {
      throw error
    },
  }
  const stop = permissions.open('/alias', 'pi', sink)
  permissions.notification(PROJECT_PERMISSION.changed)
  const record: ProjectPermission = {
    cwd: '/real',
    harness: 'pi',
    permission: ':danger-full-access',
    confirmedPermissions: [':danger-full-access'],
  }
  reads[1]?.(record)
  await Promise.resolve()
  await Promise.resolve()
  reads[0]?.({ cwd: '/real', harness: 'pi', permission: null, confirmedPermissions: [] })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(snapshots.at(-1)?.record?.permission, ':danger-full-access')
  assert.equal(snapshots.at(-1)?.cwd, '/alias')
  online = false
  permissions.resync()
  assert.equal(snapshots.at(-1)?.record, null)
  await assert.rejects(
    permissions.set({ harness: 'pi', cwd: '/alias', permission: ':read-only', confirmed: false }),
    /设备未连接/,
  )
  stop()
  permissions.notification(PROJECT_PERMISSION.changed)
  assert.equal(reads.length, 2)
})

test('不支持项目权限的连接不发送扩展请求；读取失败明确通知订阅者', async () => {
  let supported = false
  let requests = 0
  let failure: unknown
  let view: ProjectPermissionView | null = null
  const permissions = createProjectPermissions({
    deviceId: 'plain',
    online: () => true,
    supported: () => supported,
    request: async () => {
      requests++
      throw new Error('目录不存在')
    },
  })
  const stop = permissions.open('/missing', 'pi', {
    snapshot: (value) => {
      view = value as ProjectPermissionView
    },
    delta() {},
    error: (error) => {
      failure = error
    },
  })
  assert.deepEqual(view, {
    deviceId: 'plain',
    cwd: '/missing',
    harness: 'pi',
    available: false,
    record: null,
  })
  assert.equal(requests, 0)
  supported = true
  permissions.resync()
  await Promise.resolve()
  await Promise.resolve()
  assert.match(String(failure), /目录不存在/)
  stop()
})

test('保存结果立即更新选择，重读失败有提示而不是悄悄还原', async () => {
  const record: ProjectPermission = {
    cwd: '',
    harness: 'pi',
    permission: ':danger-full-access',
    confirmedPermissions: [':danger-full-access'],
  }
  let saved = false
  let shown: ProjectPermissionView | undefined
  let failure: unknown
  const permissions = createProjectPermissions({
    deviceId: 'remote',
    online: () => true,
    supported: () => true,
    request: async (method) => {
      if (method === PROJECT_PERMISSION.set) {
        saved = true
        return record
      }
      if (saved) throw new Error('重读失败')
      return { cwd: '', harness: 'pi', permission: null, confirmedPermissions: [] }
    },
  })
  const stop = permissions.open('', 'pi', {
    snapshot: (value) => {
      shown = value as ProjectPermissionView
    },
    delta() {},
    error: (error) => {
      failure = error
    },
  })
  await Promise.resolve()
  await permissions.set({
    harness: 'pi',
    cwd: '',
    permission: ':danger-full-access',
    confirmed: true,
  })
  assert.equal(shown?.record?.permission, ':danger-full-access')
  assert.match(String(failure), /重读失败/)
  stop()
})
