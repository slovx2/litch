// Windows 那一套整条走一遍：看护（launcher-win）用 node 跑假助手（apps/desktop/test/fake-win-helper.mjs，按 wire.mts 里
// Windows 助手的协议回应），执行器走 win32 分支。不要求真的是 Windows：平台是传进去的。
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type {
  ClientToolAnswer,
  ClientToolAsk,
  ClientToolContext,
  ClientToolInvocation,
} from '../../client-tools/types.mjs'
import { createComputerUse } from '../index.mjs'
import { WinLauncher } from '../launcher-win.mjs'
import { HelperSupervisor } from '../supervisor.mjs'
import { HelperError, isWinHello } from '../wire.mjs'

const root = process.env.LITCH_DESKTOP_ROOT ?? process.cwd()
const FAKE = join(root, 'test', 'fake-win-helper.mjs')
const NOTEPAD = 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'

const dirs: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  for (const child of children) if (child.exitCode === null) child.kill()
})

/** 在 macOS 上“起 exe”：用 node 跑假助手，环境变量照给 */
function spawner(env: Record<string, string> = {}) {
  return (file: string, args: string[]) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    children.push(child)
    return child
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`等不到：${what}`)
    await wait(20)
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('看护：spawn 假助手、握手、标准错误进日志；崩了不自己重拉，下次用到再起；退出时助手跟着走', async () => {
  assert.ok(existsSync(FAKE), `假助手不在：${FAKE}`)
  const logs: string[] = []
  const supervisor = new HelperSupervisor({
    launcher: new WinLauncher({ exePath: FAKE, version: '0.9.0', spawn: spawner() }),
    lang: () => 'zh-CN',
    log: (line) => logs.push(line),
  })
  const client = await supervisor.client()
  const hello = client.hello
  assert.ok(isWinHello(hello))
  assert.equal(hello.platform, 'win32')
  assert.equal(hello.integrity, 'medium')
  const diagnostics = (await client.request('diagnostics')) as { parentPid: number }
  assert.equal(diagnostics.parentPid, process.pid, '带着 --parent-pid 起')
  await until('标准错误进日志', () => logs.some((line) => line.includes('fake helper')))

  const first = hello.pid
  await client.request('_test.crash')
  await until('连接断了', () => supervisor.connected === null)
  await wait(700)
  assert.equal(supervisor.connected, null, 'onDemand：不自己重拉')
  const again = await supervisor.client()
  assert.notEqual(again.hello?.pid, first)

  // 重启：旧的退出了再起新的
  const before = again.hello?.pid ?? 0
  await supervisor.restart()
  assert.ok(!alive(before), '重启之后旧助手不在了')
  // 上面断言过 connected 是 null，TS 收窄了类型，这里重新取
  const after =
    (supervisor as { connected: { hello: { pid: number } | null } | null }).connected?.hello?.pid ??
    0
  assert.ok(after > 0 && after !== before)

  await supervisor.dispose()
  await until('dispose 之后助手退出', () => !alive(after))
})

test('看护：版本对不上、文件不在、协议不对都报错，不留进程', async () => {
  const wrong = new HelperSupervisor({
    launcher: new WinLauncher({
      exePath: FAKE,
      version: '1.2.3',
      spawn: spawner({ FAKE_VERSION: '0.9.0' }),
    }),
    lang: () => 'en',
  })
  await assert.rejects(wrong.client(), /version 0\.9\.0, Litch is 1\.2\.3/)
  assert.match(wrong.lastError ?? '', /reinstall/)
  const last = children.at(-1)
  assert.ok(last)
  await until('版本不对的助手退出', () => last.exitCode !== null || last.signalCode !== null)

  const missing = new HelperSupervisor({
    launcher: new WinLauncher({ exePath: join(tmpdir(), 'no-such-helper.exe'), version: null }),
    lang: () => 'en',
  })
  await assert.rejects(missing.client(), (error: unknown) => {
    assert.ok(error instanceof HelperError)
    assert.match(error.message, /cannot start/)
    return true
  })
})

test('看护：助手闲着自己退出后不重拉', async () => {
  const supervisor = new HelperSupervisor({
    launcher: new WinLauncher({
      exePath: FAKE,
      version: null,
      spawn: spawner({ FAKE_IDLE_MS: '150' }),
    }),
    lang: () => 'en',
  })
  const client = await supervisor.client()
  const pid = client.hello?.pid ?? 0
  await until('闲着退出', () => supervisor.connected === null)
  await wait(700)
  assert.equal(supervisor.connected, null)
  assert.ok(!alive(pid))
  await supervisor.dispose()
})

// —— 执行器 ——

function invocation(
  tool: string,
  args: Record<string, unknown>,
  device: Partial<ClientToolInvocation['device']> = {},
): ClientToolInvocation {
  return {
    id: `call-${tool}`,
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'c',
    namespace: 'litch_computer',
    tool,
    arguments: args,
    device: { id: 'local', name: 'local', kind: 'local', target: null, ...device },
    harness: null,
    cwd: null,
  }
}

function asker(answer: ClientToolAnswer | null = 'session') {
  const asks: ClientToolAsk[] = []
  const context: ClientToolContext = {
    signal: new AbortController().signal,
    ask: async (ask) => {
      asks.push(ask)
      return answer
    },
  }
  return { asks, context }
}

const textOf = (response: { contentItems: { type: string; text?: string }[] }) =>
  response.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')

test('执行器（win32）：列应用、审批、取状态、编号换 ref、坐标带截图号、动作后的差异', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'litch-cu-win-'))
  dirs.push(userData)
  const cu = createComputerUse({
    platform: 'win32',
    userData,
    helperPath: FAKE,
    version: null,
    lang: 'zh-CN',
    spawnWin: spawner(),
  })
  try {
    const { executor } = cu
    const { asks, context } = asker('session')

    const listed = await executor.call(invocation('list_apps', {}), context)
    const list = textOf(listed)
    assert.match(list, /- Notepad — Microsoft\.WindowsNotepad_8wekyb3d8bbwe!App \(frontmost\)/)
    assert.match(list, /window 1002: "Save As"/)
    assert.match(list, /Task Manager — .*Taskmgr\.exe \(not allowed\)/)
    assert.match(list, /Command Prompt — .* \(runs as administrator; cannot be controlled\)/)

    // 禁止的、管理员的：不弹卡片
    const taskmgr = await executor.call(invocation('get_app_state', { app: 'taskmgr' }), context)
    assert.equal(taskmgr.success, false)
    assert.match(textOf(taskmgr), /^\[litch:declined\] Task Manager cannot be controlled/)
    const admin = await executor.call(invocation('click', { app: 'cmd.exe', x: 1, y: 1 }), context)
    assert.match(textOf(admin), /^\[litch:failed\] Command Prompt runs as administrator/)
    assert.equal(asks.length, 0)

    // 第一次取状态：问一次（高风险标在卡片上的是资源管理器，记事本是普通的）
    const state = await executor.call(invocation('get_app_state', { app: 'notepad' }), context)
    assert.equal(state.success, true, textOf(state))
    assert.equal(asks.length, 1)
    assert.deepEqual(asks[0], {
      kind: 'app',
      app: { name: 'Notepad', bundleId: NOTEPAD },
      risk: 'normal',
      allowAlways: true,
    })
    const first = textOf(state)
    assert.match(
      first,
      /^App: Notepad \(Microsoft\.WindowsNotepad_8wekyb3d8bbwe!App\), window 1001 "Untitled - Notepad"\./,
    )
    assert.match(first, /Other windows of this app: 1002 "Save As"\./)
    assert.match(first, /Screenshot: 800x600 pixels/)
    assert.match(
      first,
      /\[1\] Window "Untitled - Notepad"\n {2}\[2\] MenuItem "File"\n {2}\[3\] Document "Text editor" \{focused\}/,
    )
    assert.ok(state.contentItems.some((item) => item.type === 'inputImage'))

    // 打字：编号换成 ref，结果带差异；同一会话不再问
    const typed = await executor.call(
      invocation('type_text', { app: NOTEPAD, text: 'hello', element: 3 }),
      context,
    )
    assert.equal(asks.length, 1)
    assert.match(
      textOf(typed),
      /^Typed 5 characters\.\n\nChanges in the app's accessibility tree since the last state:\n~ \[3\] Document "Text editor" = "hello" \{focused\}/,
    )

    // 点菜单，冒出一个按钮
    const clicked = await executor.call(
      invocation('click', { app: 'Notepad', element: 2 }),
      context,
    )
    assert.match(textOf(clicked), /\+ \[4\] Button "Save"/)

    // 坐标：带上最近一次截图的号；截图之后窗口挪过就 stale
    await executor.call(invocation('click', { app: 'Notepad', x: 100, y: 200 }), context)
    await cu.supervisor.connected?.request('_test.move')
    const stale = await executor.call(
      invocation('click', { app: 'Notepad', x: 100, y: 200 }),
      context,
    )
    assert.match(textOf(stale), /^\[litch:failed\] The window changed since the screenshot/)
    const outside = await executor.call(
      invocation('click', { app: 'Notepad', x: 900, y: 1 }),
      context,
    )
    assert.match(textOf(outside), /^\[litch:invalid\] .*outside the screenshot/)

    // 拖：元素换成中心坐标
    await executor.call(invocation('get_app_state', { app: 'Notepad' }), context)
    const dragged = await executor.call(
      invocation('drag', { app: 'Notepad', from_element: 3, to_x: 10, to_y: 10 }),
      context,
    )
    assert.match(textOf(dragged), /^Dragged\./)

    // Windows 键先拒；ctrl+s 拆开交给助手
    const winKey = await executor.call(
      invocation('press_key', { app: 'Notepad', key: 'win+r' }),
      context,
    )
    assert.match(textOf(winKey), /^\[litch:invalid\] The Windows key is not allowed/)
    await executor.call(invocation('press_key', { app: 'Notepad', key: 'ctrl+s' }), context)

    // 换窗口：对话框给全文，带着助手的说明
    const dialog = await executor.call(
      invocation('get_app_state', { app: 'Notepad', window: 1002 }),
      context,
    )
    const dialogText = textOf(dialog)
    assert.match(dialogText, /window 1002 "Save As"/)
    assert.match(dialogText, /Other windows of this app: 1001 "Untitled - Notepad"\./)
    assert.match(dialogText, /Note: This window is a dialog\./)
    assert.match(dialogText, /Accessibility tree:\n\[\d+\] Window "Save As"/)
    // 之后不给 window 就用这个窗口
    await executor.call(
      invocation('set_value', { app: 'Notepad', element: 6, value: 'a.txt' }),
      context,
    )

    const { calls } = (await (await cu.supervisor.client()).request('_test.calls')) as {
      calls: { method: string; params: Record<string, unknown> }[]
    }
    const sent = (method: string) => calls.filter((call) => call.method === method)
    assert.deepEqual(sent('typeText')[0]?.params, {
      session: 'local/thread-1',
      appId: NOTEPAD,
      windowId: 1001,
      text: 'hello',
      ref: '1001.3',
    })
    const clicks = sent('click')
    assert.equal(clicks[0]?.params.ref, '1001.2')
    assert.equal(clicks[1]?.params.screenshotId, 'shot-1')
    assert.equal(clicks[1]?.params.x, 100)
    assert.deepEqual(sent('drag')[0]?.params, {
      session: 'local/thread-1',
      appId: NOTEPAD,
      windowId: 1001,
      screenshotId: 'shot-2',
      from: { x: 400, y: 300 },
      to: { x: 10, y: 10 },
    })
    assert.deepEqual(sent('pressKey')[0]?.params.modifiers, ['ctrl'])
    assert.equal(sent('pressKey').length, 1, 'Windows 键没交给助手')
    assert.equal(sent('setValue')[0]?.params.windowId, 1002)
    assert.equal(sent('setValue')[0]?.params.ref, '1002.1')
    // 每个动作之后都不截图取一次树
    const followUps = sent('getAppState').filter((call) => call.params.screenshot === false)
    assert.ok(followUps.length >= 5)
  } finally {
    await cu.dispose()
  }
})

test('执行器（win32）：物理 Esc 之后本回合不再操作，回合结束恢复；锁屏；远程会话没有始终允许', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'litch-cu-win-'))
  dirs.push(userData)
  const stops: string[] = []
  const cu = createComputerUse({
    platform: 'win32',
    userData,
    helperPath: FAKE,
    version: null,
    lang: 'en',
    spawnWin: spawner(),
    onStopped: (notice) => stops.push(JSON.stringify(notice)),
  })
  try {
    const { executor } = cu
    const { context } = asker('session')
    const ok = await executor.call(invocation('get_app_state', { app: 'Notepad' }), context)
    assert.equal(ok.success, true)
    await cu.supervisor.connected?.request('_test.stop', {
      session: 'local/thread-1',
      appId: NOTEPAD.toUpperCase(),
    })
    await until('停止通知到了', () => stops.length === 1)
    const refused = await executor.call(
      invocation('press_key', { app: 'Notepad', key: 'a' }),
      context,
    )
    assert.match(textOf(refused), /^\[litch:failed\] The user stopped you from controlling Notepad/)
    // 别的会话不受影响
    const other = await executor.call(
      { ...invocation('get_app_state', { app: 'Notepad' }), threadId: 'thread-2' },
      context,
    )
    assert.equal(other.success, true)

    executor.turnEnded?.({ deviceId: 'local', threadId: 'thread-1', turnId: 'turn-1' })
    const back = await executor.call(invocation('get_app_state', { app: 'Notepad' }), context)
    assert.equal(back.success, true)
    // 回合结束清了编号：又是全文
    assert.match(textOf(back), /Accessibility tree:\n\[1\] Window/)

    await cu.supervisor.connected?.request('_test.lock')
    const locked = await executor.call(
      invocation('press_key', { app: 'Notepad', key: 'a' }),
      context,
    )
    assert.match(
      textOf(locked),
      /^\[litch:failed\] The desktop is locked\..*ask the user to unlock/,
    )
    await cu.supervisor.connected?.request('_test.unlock')

    const remote = asker('session')
    await executor.call(
      invocation('get_app_state', { app: 'File Explorer' }, { id: 'build', kind: 'ssh' }),
      remote.context,
    )
    assert.equal(remote.asks.length, 1)
    assert.deepEqual(remote.asks[0], {
      kind: 'app',
      app: { name: 'File Explorer', bundleId: 'C:\\Windows\\explorer.exe' },
      risk: 'elevated',
      allowAlways: false,
    })
  } finally {
    await cu.dispose()
  }
})
