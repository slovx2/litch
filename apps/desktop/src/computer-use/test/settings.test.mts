// 设置页里 Computer Use 那一节在主进程这一侧的逻辑（settings.mts）：什么时候拉起助手、上一次问到的、
// 出错时怎么说、自检用的假权限。助手用桩，不起真的应用。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AlwaysAllowedApp } from '../approvals.mjs'
import type { WinHelperInfo } from '../index.mjs'
import {
  type ComputerUseControls,
  createComputerUseSettings,
  fakePermissions,
} from '../settings.mjs'
import type { PermissionStatus } from '../wire.mjs'

function stub(granted: PermissionStatus, platform: 'darwin' | 'win32' = 'darwin') {
  const calls: string[] = []
  let running = false
  let now = { ...granted }
  let apps: AlwaysAllowedApp[] = [
    { bundleId: 'com.apple.TextEdit', name: 'TextEdit', addedAt: '2026-10-17T00:00:00.000Z' },
  ]
  let info: WinHelperInfo | null = null
  let failure: string | null = null
  const controls: ComputerUseControls = {
    platform,
    async helperInfo(launch) {
      calls.push(`helperInfo:${launch}`)
      if (launch) running = true
      return running ? info : null
    },
    lastError: () => failure,
    async permissions() {
      calls.push('permissions')
      running = true
      return { ...now }
    },
    running: () => running,
    async openPermissionSettings(pane) {
      calls.push(`open:${pane}`)
      return true
    },
    async restartHelper() {
      calls.push('restart')
      running = true
    },
    listAlwaysAllowed: () => apps,
    removeAlwaysAllowed(bundleId) {
      const before = apps.length
      apps = apps.filter((app) => app.bundleId !== bundleId)
      return apps.length < before
    },
  }
  return {
    controls,
    calls,
    grant(next: PermissionStatus) {
      now = { ...next }
    },
    stop() {
      running = false
    },
    setInfo(next: WinHelperInfo | null) {
      info = next
    },
    fail(reason: string | null) {
      failure = reason
    },
  }
}

test('不拉起时：助手没在跑就回上一次问到的，一次没问过是 null', async () => {
  const helper = stub({ accessibility: true, screenRecording: false })
  const settings = createComputerUseSettings(helper.controls)
  assert.deepEqual(await settings.status(false), {
    platform: 'darwin',
    helper: 'idle',
    permissions: null,
  })
  assert.deepEqual(helper.calls, [])

  // 设置页那一节拉起助手问一次
  const asked = await settings.status(true)
  assert.deepEqual(asked, {
    platform: 'darwin',
    helper: 'ready',
    permissions: { accessibility: true, screenRecording: false },
  })
  assert.deepEqual(helper.calls, ['permissions'])

  // 助手还在跑：不拉起的那种也照样现问
  helper.grant({ accessibility: true, screenRecording: true })
  assert.deepEqual((await settings.status(false)).permissions, {
    accessibility: true,
    screenRecording: true,
  })

  // 助手退了：回上一次的
  helper.stop()
  assert.deepEqual(await settings.status(false), {
    platform: 'darwin',
    helper: 'idle',
    permissions: { accessibility: true, screenRecording: true },
  })
  assert.equal(helper.calls.length, 2)
})

test('助手起不来：报 failed 和原话，不留成上一次的结果', async () => {
  const helper = stub({ accessibility: true, screenRecording: true })
  helper.controls.permissions = async () => {
    throw new Error('helper app missing')
  }
  const settings = createComputerUseSettings(helper.controls)
  assert.deepEqual(await settings.status(true), {
    platform: 'darwin',
    helper: 'failed',
    permissions: null,
    reason: 'helper app missing',
  })
  assert.deepEqual(await settings.status(false), {
    platform: 'darwin',
    helper: 'idle',
    permissions: null,
  })
})

test('打开系统设置只认两种页；重启之后重新问', async () => {
  const helper = stub({ accessibility: true, screenRecording: false })
  const settings = createComputerUseSettings(helper.controls)
  assert.equal(await settings.openSettings('screenRecording'), true)
  assert.equal(await settings.openSettings('fullDiskAccess'), false)
  assert.equal(await settings.openSettings(null), false)
  helper.grant({ accessibility: true, screenRecording: true })
  const after = await settings.restart()
  assert.deepEqual(after.permissions, { accessibility: true, screenRecording: true })
  assert.deepEqual(helper.calls, ['open:screenRecording', 'restart', 'permissions'])
})

test('始终允许：列出、按包标识删，乱给的不删', async () => {
  const helper = stub({ accessibility: true, screenRecording: true })
  const settings = createComputerUseSettings(helper.controls)
  assert.equal(settings.apps().length, 1)
  assert.equal(settings.forgetApp(''), false)
  assert.equal(settings.forgetApp(42), false)
  assert.equal(settings.forgetApp('com.apple.TextEdit'), true)
  assert.deepEqual(settings.apps(), [])
})

test('自检用的假权限：不碰助手', async () => {
  assert.equal(fakePermissions(undefined), null)
  assert.equal(fakePermissions('maybe'), null)
  assert.deepEqual(fakePermissions('accessibility'), {
    accessibility: true,
    screenRecording: false,
  })
  const helper = stub({ accessibility: true, screenRecording: true })
  const settings = createComputerUseSettings(helper.controls, fakePermissions('none'))
  assert.deepEqual(await settings.status(false), {
    platform: 'darwin',
    helper: 'ready',
    permissions: { accessibility: false, screenRecording: false },
  })
  assert.equal(await settings.openSettings('accessibility'), true)
  assert.equal((await settings.restart()).helper, 'ready')
  assert.deepEqual(helper.calls, [])
})

test('Windows：没有系统权限，回助手的状态；不拉起时回上一次的和上次的错', async () => {
  const helper = stub({ accessibility: false, screenRecording: false }, 'win32')
  const settings = createComputerUseSettings(helper.controls)
  assert.deepEqual(await settings.status(false), {
    platform: 'win32',
    helper: 'idle',
    permissions: null,
    windows: null,
  })
  assert.deepEqual(helper.calls, [])

  const info: WinHelperInfo = { pid: 7, version: '0.9.0', integrity: 'high', uacEnabled: false }
  helper.setInfo(info)
  assert.deepEqual(await settings.status(true), {
    platform: 'win32',
    helper: 'ready',
    permissions: null,
    windows: info,
  })
  assert.deepEqual(helper.calls, ['helperInfo:true'])

  // 助手退了（60 秒没请求自己退出）：回上一次的，带上上次的错
  helper.stop()
  helper.fail('cannot start litch-computer-use.exe')
  assert.deepEqual(await settings.status(false), {
    platform: 'win32',
    helper: 'idle',
    permissions: null,
    windows: info,
    reason: 'cannot start litch-computer-use.exe',
  })
  // 没有系统设置可开
  assert.equal(await settings.openSettings('accessibility'), false)
  assert.ok(
    !(helper.calls as string[]).some((call) => call.startsWith('open:') || call === 'permissions'),
  )

  // 拉起出错
  helper.controls.helperInfo = async () => {
    throw new Error('helper did not start')
  }
  assert.deepEqual(await settings.status(true), {
    platform: 'win32',
    helper: 'failed',
    permissions: null,
    windows: null,
    reason: 'helper did not start',
  })
})

test('Windows 自检：不碰助手，回一份假的助手状态', async () => {
  const helper = stub({ accessibility: true, screenRecording: true }, 'win32')
  const settings = createComputerUseSettings(helper.controls, fakePermissions('both'))
  const state = await settings.status(true)
  assert.equal(state.platform, 'win32')
  assert.equal(state.helper, 'ready')
  assert.equal(state.windows?.integrity, 'medium')
  assert.deepEqual(helper.calls, [])
})
