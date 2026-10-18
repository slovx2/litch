// Computer Use 的端到端自检，不需要任何系统授权：真的经 LaunchServices 起助手、握手，调不要权限的几样
// （诊断、权限状态、列应用），并且确认几种该拒的连接被拒了。不点、不截图、不打字。
// 由 scripts/check-computer-use.mjs 打包后运行；那边负责组装助手应用、准备临时目录。
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HelperClient } from './helper-client.mjs'
import { createComputerUse } from './index.mjs'
import { HelperSupervisor } from './supervisor.mjs'
import { HelperError } from './wire.mjs'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function expectRejected(
  promise: Promise<unknown>,
  kind: string,
  what: string,
): Promise<void> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof HelperError, `${what}：应当是助手的错误，实际是 ${String(error)}`)
    assert.equal(error.kind, kind, `${what}：错误分类`)
    return
  }
  assert.fail(`${what}：应当被拒`)
}

/** 临时签名的助手：令牌那一套 */
export async function checkAdhoc(appPath: string, userData: string): Promise<string[]> {
  const report: string[] = []
  const logs: string[] = []
  const cu = createComputerUse({
    userData,
    appPath,
    version: null,
    lang: 'zh-CN',
    log: (line) => logs.push(line),
  })
  try {
    const client = await cu.supervisor.client()
    const hello = client.hello
    assert.ok(hello, '握手过的连接带着握手结果')
    assert.equal(hello.auth, 'token', '临时签名的助手按令牌验')
    assert.equal(hello.teamId, null)
    report.push(`握手：进程 ${hello.pid}，版本 ${hello.version}，校验方式 ${hello.auth}`)

    // 守住授权的归属：经 open 起的助手父进程是 launchd，责任进程是它自己
    const diagnostics = (await client.request('diagnostics')) as Record<string, unknown>
    assert.equal(diagnostics.ppid, 1, '助手的父进程应当是 launchd')
    assert.equal(diagnostics.responsibleIsSelf, true, '助手应当是自己的责任进程')
    report.push(
      `责任进程：${diagnostics.responsiblePid}（就是助手自己），父进程 ${diagnostics.ppid}`,
    )

    const directory = join(userData, 'computer-use')
    assert.equal(statSync(directory).mode & 0o777, 0o700, '目录只有属主能进')
    assert.equal(
      statSync(join(directory, 'helper.sock')).mode & 0o777,
      0o600,
      '套接字只有属主能读写',
    )
    assert.equal(Number(readFileSync(join(directory, 'helper.pid'), 'utf8')), hello.pid)

    const permissions = await cu.permissions()
    assert.equal(typeof permissions.accessibility, 'boolean')
    assert.equal(typeof permissions.screenRecording, 'boolean')
    report.push(
      `权限：辅助功能 ${permissions.accessibility}，屏幕录制 ${permissions.screenRecording}（只查不弹窗）`,
    )

    const listed = await cu.executor.call(
      {
        id: 'self-check',
        threadId: 'self-check',
        turnId: 't',
        callId: 'c',
        namespace: 'litch_computer',
        tool: 'list_apps',
        arguments: {},
        device: { id: 'local', name: 'local', kind: 'local', target: null },
        harness: null,
        cwd: null,
      },
      { signal: new AbortController().signal, ask: async () => null },
    )
    assert.equal(listed.success, true, JSON.stringify(listed))
    const first = listed.contentItems[0]
    assert.ok(first?.type === 'inputText')
    report.push(`list_apps：${first.text.split('\n').length - 1} 个带窗口的应用`)

    // 该拒的连接
    const socket = cu.supervisor.socketPath
    const stranger = await HelperClient.connect(socket)
    await expectRejected(stranger.request('listApps'), 'unauthorized', '没握手就请求')
    const wrong = await HelperClient.connect(socket)
    await expectRejected(wrong.handshake('0'.repeat(64), 'en'), 'unauthorized', '令牌不对')
    await wait(100)
    assert.equal(wrong.isOpen, false, '握手不过要断开')
    const noToken = await HelperClient.connect(socket)
    await expectRejected(noToken.handshake(null, 'en'), 'unauthorized', '不带令牌')
    report.push('没握手、令牌不对、不带令牌的连接都被拒并断开')
    // 正常那条不受影响
    assert.equal((await client.request('permissions')) !== null, true)

    // 语言、回合结束
    cu.setLanguage('en')
    await client.request('turnEnded', { session: 'local/self-check' })

    // 崩溃重拉：结束助手进程，看护者自己拉起一个新的
    process.kill(hello.pid, 'SIGKILL')
    let next: HelperClient | null = null
    for (let i = 0; i < 100; i += 1) {
      await wait(100)
      next = cu.supervisor.connected
      if (next && next.hello?.pid !== hello.pid) break
    }
    const relaunched = next?.hello
    assert.ok(relaunched && relaunched.pid !== hello.pid, '助手被杀之后应当重拉')
    report.push(`助手被杀之后重拉了：新进程 ${relaunched.pid}`)
  } finally {
    await cu.dispose()
  }
  // 退出后套接字上没人在听
  await wait(800)
  const stillThere = await HelperClient.connect(join(userData, 'computer-use', 'helper.sock')).then(
    (left) => {
      left.close()
      return true
    },
    () => false,
  )
  assert.equal(stillThere, false, 'Litch 退出后助手应当跟着退出')
  report.push('dispose 之后助手退出了')
  return report
}

/** 开发者身份签名的助手：连进来的不是 Litch（这里是 Node）就拒，令牌也不认 */
export async function checkTeamSigned(appPath: string, directory: string): Promise<string[]> {
  const report: string[] = []
  const supervisor = new HelperSupervisor({
    appPath,
    directory,
    version: null,
    lang: () => 'en',
  })
  try {
    await expectRejected(supervisor.client(), 'unauthorized', '开发者身份签名的助手不认 Node')
    report.push('开发者身份签名的助手：Node 带着正确的一次性令牌也被拒（只认同团队签名的 Litch）')
  } finally {
    // 握手不过，没法请它退出：按进程号文件结束
    try {
      const pid = Number(readFileSync(join(directory, 'helper.pid'), 'utf8'))
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  return report
}
