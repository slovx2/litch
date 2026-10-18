// 假的 Windows Computer Use 助手：按 src/computer-use/wire.mts 里 Windows 助手的协议回应，
// 让 macOS 上也能把主进程的 Windows 那一套（launcher-win、executor-win、ax-text、名单）整条测到。
// 不碰任何系统接口：应用、窗口、界面树都是写死的，动作只改内存里的状态并记下来。
//
// 跑法：node fake-win-helper.mjs --parent-pid <进程号>。连接是标准输入输出（4 字节大端长度 + JSON-RPC），
// 标准错误只写日志。标准输入关了、父进程没了、FAKE_IDLE_MS（默认 60000）毫秒没有请求就退出。
// 环境变量：FAKE_VERSION（握手报的版本，默认 0.9.0）、FAKE_INTEGRITY（默认 medium）、FAKE_UAC（0 是关）。
//
// 测试用的方法（真的助手没有）：_test.calls 回收到的全部请求；_test.stop {session, appId} 发一条 stopped 通知；
// _test.move 让窗口“挪过”（之后带旧截图号的坐标动作回 stale）；_test.lock / _test.unlock 锁屏；_test.crash 直接退出。
const args = process.argv.slice(2)
const parentAt = args.indexOf('--parent-pid')
const parentPid = parentAt >= 0 ? Number(args[parentAt + 1]) : Number.NaN
if (!Number.isInteger(parentPid)) {
  process.stderr.write('missing --parent-pid\n')
  process.exit(2)
}
const PROTOCOL = 1
const IDLE_MS = Number(process.env.FAKE_IDLE_MS ?? 60_000)
const log = (line) => process.stderr.write(`${line}\n`)
log(`fake helper ${process.pid} started for parent ${parentPid}`)

// —— 帧 ——
let buffer = Buffer.alloc(0)
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0)
    if (buffer.length < 4 + length) break
    const body = buffer.subarray(4, 4 + length).toString('utf8')
    buffer = buffer.subarray(4 + length)
    handle(JSON.parse(body))
  }
})
process.stdin.on('end', () => {
  log('stdin closed, exiting')
  process.exit(0)
})

// —— 退出的几种 ——
let idle = setTimeout(quitIdle, IDLE_MS)
function quitIdle() {
  log('idle, exiting')
  process.exit(0)
}
setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    log('parent gone, exiting')
    process.exit(0)
  }
}, 500).unref()

// —— 写死的桌面 ——
const NOTEPAD = 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'
const EXPLORER = 'C:\\Windows\\explorer.exe'
const TASKMGR = 'C:\\Windows\\System32\\Taskmgr.exe'
const ADMIN_CMD = 'C:\\Windows\\System32\\cmd.exe'
const APPS = [
  {
    appId: NOTEPAD,
    name: 'Notepad',
    exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad\\Notepad\\Notepad.exe',
    aumid: NOTEPAD,
    pid: 101,
    active: true,
    integrity: 'medium',
    windows: [
      { id: 1001, title: 'Untitled - Notepad', active: true, minimized: false },
      { id: 1002, title: 'Save As', active: false, minimized: false },
    ],
  },
  {
    appId: EXPLORER,
    name: 'File Explorer',
    exe: EXPLORER,
    aumid: null,
    pid: 102,
    active: false,
    integrity: 'medium',
    windows: [{ id: 2001, title: 'Downloads', active: false, minimized: false }],
  },
  {
    appId: TASKMGR,
    name: 'Task Manager',
    exe: TASKMGR,
    aumid: null,
    pid: 103,
    active: false,
    integrity: 'medium',
    windows: [{ id: 3001, title: 'Task Manager', active: false, minimized: false }],
  },
  {
    appId: ADMIN_CMD,
    name: 'Command Prompt',
    exe: ADMIN_CMD,
    aumid: null,
    pid: 104,
    active: false,
    integrity: 'high',
    windows: [
      { id: 4001, title: 'Administrator: Command Prompt', active: false, minimized: false },
    ],
  },
]
const state = { text: '', saveShown: false, shot: 0, moved: false, locked: false }
const calls = []

function tree(windowId) {
  if (windowId === 1002) {
    return node('1002', 'Window', { name: 'Save As' }, [
      node('1002.1', 'Edit', {
        name: 'File name:',
        value: '*.txt',
        frame: rect(100, 400, 300, 24),
      }),
      node('1002.2', 'Button', {
        name: 'Save',
        actions: ['invoke'],
        frame: rect(420, 440, 80, 24),
      }),
    ])
  }
  return node('1001', 'Window', { name: 'Untitled - Notepad' }, [
    node('1001.1', 'Pane', {}, [
      node('1001.2', 'MenuItem', { name: 'File', actions: ['expand'], frame: rect(0, 0, 40, 20) }),
      node('1001.3', 'Document', {
        name: 'Text editor',
        value: state.text,
        states: ['focused'],
        actions: ['setValue', 'text'],
        frame: rect(0, 30, 800, 540),
      }),
      ...(state.saveShown
        ? [
            node('1001.4', 'Button', {
              name: 'Save',
              actions: ['invoke'],
              frame: rect(700, 570, 80, 24),
            }),
          ]
        : []),
    ]),
  ])
}
function node(ref, role, extra = {}, children = []) {
  return { ref, role, states: [], actions: [], children, ...extra }
}
function rect(x, y, width, height) {
  return { x, y, width, height }
}

// —— 处理 ——
class RpcError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}
let greeted = false

function handle(message) {
  clearTimeout(idle)
  idle = setTimeout(quitIdle, IDLE_MS)
  const { id, method, params = {} } = message
  if (method !== '_test.calls') calls.push({ method, params })
  try {
    const result = dispatch(method, params)
    send({ jsonrpc: '2.0', id, result })
    if (method === 'shutdown') setTimeout(() => process.exit(0), 10)
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error.message, data: { kind: error.kind ?? 'failed' } },
    })
  }
}

function findApp(appId) {
  const app = APPS.find((one) => one.appId.toLowerCase() === String(appId).toLowerCase())
  if (!app) throw new RpcError('notFound', `No app ${appId}.`)
  return app
}

function prepare(params) {
  if (typeof params.session !== 'string') throw new RpcError('invalid', 'session is required')
  const app = findApp(params.appId)
  if (state.locked) throw new RpcError('locked', 'The desktop is locked.')
  if (app.integrity === 'high') throw new RpcError('elevated', `${app.name} runs as administrator.`)
  const windowId = params.windowId ?? app.windows[0].id
  if (!app.windows.some((one) => one.id === windowId)) {
    throw new RpcError('notFound', `Window ${windowId} is not a window of ${app.name}.`)
  }
  return { app, windowId }
}

/** 坐标动作：截图号要是最近的、窗口没挪过 */
function checkShot(params) {
  if (params.x === undefined && params.from === undefined) return
  if (params.screenshotId !== `shot-${state.shot}` || state.moved) {
    throw new RpcError(
      'stale',
      'The window changed since the screenshot. Call get_app_state again.',
    )
  }
}

function dispatch(method, params) {
  if (method === 'hello') {
    if (params.protocol !== PROTOCOL) throw new RpcError('invalid', `protocol ${params.protocol}`)
    greeted = true
    return {
      protocol: PROTOCOL,
      pid: process.pid,
      version: process.env.FAKE_VERSION ?? '0.9.0',
      platform: 'win32',
      integrity: process.env.FAKE_INTEGRITY ?? 'medium',
      uacEnabled: process.env.FAKE_UAC !== '0',
    }
  }
  if (!greeted) throw new RpcError('invalid', 'say hello first')
  switch (method) {
    case 'diagnostics':
      return {
        pid: process.pid,
        parentPid,
        exe: process.argv[1],
        version: process.env.FAKE_VERSION ?? '0.9.0',
        osVersion: 'fake',
        integrity: process.env.FAKE_INTEGRITY ?? 'medium',
        inputDesktop: state.locked ? 'Winlogon' : 'Default',
        dpiAwareness: 'perMonitorV2',
        uia: true,
        wgc: true,
        borderlessCapture: true,
      }
    case 'setLanguage':
    case 'turnEnded':
    case 'shutdown':
      return {}
    case 'listApps':
      return { apps: APPS }
    case 'getAppState': {
      const { app, windowId } = prepare(params)
      const window = app.windows.find((one) => one.id === windowId)
      const withShot = params.screenshot !== false
      if (withShot) {
        state.shot += 1
        state.moved = false
      }
      return {
        app: { appId: app.appId, name: app.name, exe: app.exe, aumid: app.aumid, pid: app.pid },
        window: { id: window.id, title: window.title, width: 800, height: 600 },
        windows: app.windows.map((one) => ({ id: one.id, title: one.title })),
        screenshot: withShot
          ? { id: `shot-${state.shot}`, mime: 'image/jpeg', data: 'QUJD', width: 800, height: 600 }
          : null,
        tree: tree(windowId),
        truncated: false,
        notes: windowId === 1002 ? ['This window is a dialog.'] : [],
      }
    }
    case 'click': {
      prepare(params)
      checkShot(params)
      if (params.ref === '1001.2') state.saveShown = true
      return {}
    }
    case 'typeText':
      prepare(params)
      state.text += params.text
      return {}
    case 'pressKey':
      prepare(params)
      if (['win', 'windows'].includes(String(params.key).toLowerCase())) {
        throw new RpcError('invalid', 'The Windows key is not allowed.')
      }
      return {}
    case 'setValue':
      prepare(params)
      if (params.ref === '1001.3') state.text = params.value
      return {}
    case 'scroll':
    case 'selectText':
      prepare(params)
      checkShot(params)
      return {}
    case 'drag':
      prepare(params)
      checkShot(params)
      return {}
    case '_test.calls':
      return { calls }
    case '_test.stop':
      send({
        jsonrpc: '2.0',
        method: 'stopped',
        params: { session: params.session, appId: params.appId },
      })
      return {}
    case '_test.move':
      state.moved = true
      return {}
    case '_test.lock':
      state.locked = true
      return {}
    case '_test.unlock':
      state.locked = false
      return {}
    case '_test.crash':
      setTimeout(() => process.exit(3), 10)
      return {}
    default:
      throw new RpcError('invalid', `unknown method ${method}`)
  }
}
