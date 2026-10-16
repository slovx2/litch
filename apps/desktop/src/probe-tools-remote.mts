// 客户端工具的远程端到端（scripts/check-tools-remote.mjs 打包后用 Electron 起，不开任何窗口）：
// 真的核心经系统的 ssh 连到假远程机器上的完整设备服务（真的适配器命令行拉起的设备进程加隔离的 Pi，模型是
// 回环上的假模型），桌面这一头是真的内置浏览器（WebContentsView + CDP）加 litch_echo，转发是真的 ssh -N -L。
//   1. 模型调 litch_echo：调用经设备服务、ssh 回到桌面执行，结果回到模型；
//   2. 模型让浏览器打开远端的 http://localhost:<端口>/go（它重定向到绝对地址 /second），等页面上 WebSocket
//      收到消息、读快照：浏览器经 ssh 转发打开远端页面，重定向也改写到转发上，结果回到模型；
//   3. 把转发的 ssh 结束掉，再浏览一次：转发在原来的本机端口上重建；
//   4. 撤掉转发，ssh 进程跟着退。
// 远端网页由起它的脚本在回环上开（LITCH_FX_WEB 是端口），它记下每个请求的 Host 头：浏览器要是没走转发，
// Host 里就是远端的那个端口。结果打一行 LITCH_TOOLS_REMOTE {ok, checks}。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  type Clock,
  createCore,
  type DeviceView,
  type RemoteTarget,
  reduceSession,
  type SessionOp,
  type SessionView,
} from '@litch/core'
import { app } from 'electron'
import { createElectronHost } from './browser/electron-host.mjs'
import { createBrowserExecutor } from './browser/executor.mjs'
import { createBrowserForwarding } from './browser/forwarding.mjs'
import { createSiteBook } from './browser/sites.mjs'
import { createClientToolHost } from './client-tools/host.mjs'
import { createExecutors } from './client-tools/registry.mjs'
import { CLIENT_TOOL, type ClientToolToCore, type ClientToolToMain } from './client-tools/types.mjs'
import { sshOpener } from './transport-ssh.mjs'

const profile = process.env.LITCH_PROFILE ?? ''
if (profile) app.setPath('userData', profile)
const alias = process.env.LITCH_FX_ALIAS ?? ''
const work = process.env.LITCH_FX_WORK ?? null
const webPort = Number(process.env.LITCH_FX_WEB)

interface Check {
  name: string
  ok: boolean
  detail?: unknown
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(ok ? {} : { detail }) })
  console.error(`[probe] ${ok ? '过' : '没过'}：${name}`)
}
const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}
const never = { aborted: false, addEventListener() {} }

async function until<T>(what: string, probe: () => T | null | undefined | false, ms = 90_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`等不到：${what}`)
    await new Promise((done) => setTimeout(done, 50))
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
/** 外面那层 sh 底下的 ssh（转发的看门狗只有这一个后台子进程是 ssh） */
const sshUnder = (pid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(pid), 'ssh'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

void app.whenReady().then(async () => {
  app.dock?.hide()
  const limit = setTimeout(() => finish('超时'), 280_000)
  const target: RemoteTarget = { kind: 'alias', alias }
  const deviceId = 'ssh-1'

  // ---------- 主进程那一头：照 main.mts 和 browser/install.mts 的接法 ----------
  const host = createElectronHost()
  const forwarding = createBrowserForwarding({
    targetOf: (id) => (id === deviceId ? target : null),
    tabs: () => host.list(),
    portsFile: join(profile, 'browser', 'forwards.json'),
    log: (line) => console.error(`[browser] ${line}`),
  })
  host.setNavigationRewrite((page, url) => forwarding.rewrite(page, url))
  const browser = createBrowserExecutor({
    host,
    sites: createSiteBook(join(profile, 'sites.json')),
    resolveUrl: forwarding.resolveUrl,
    describeUrl: forwarding.describeUrl,
  })
  let toCore: ((message: ClientToolToCore) => void) | null = null
  const tools = createClientToolHost(
    [
      ...createExecutors({
        platform: process.platform,
        env: { LITCH_CLIENT_TOOLS_ECHO: '1' },
        log: (line) => console.error(`[client-tools] ${line}`),
      }),
      browser,
    ],
    (message) => queueMicrotask(() => toCore?.(structuredClone(message))),
  )
  const core = createCore({
    clock,
    version: '0.0.0-check',
    log: (line) => {
      if (process.env.LITCH_CHECK_DEBUG) console.error(`[core] ${line}`)
    },
    clientTools: {
      namespaces: () => tools.namespaces(),
      post: (message) =>
        queueMicrotask(() => tools.handle(structuredClone(message) as ClientToolToMain)),
      listen(handler) {
        toCore = (message) => {
          if (message.type === CLIENT_TOOL) handler(message)
        }
      },
    },
    devices: [
      {
        id: deviceId,
        name: alias,
        host: alias,
        kind: 'ssh',
        target,
        wire: 'orange',
        open: sshOpener(target),
      },
    ],
  })

  let finished = false
  function finish(error?: string) {
    if (finished) return
    finished = true
    clearTimeout(limit)
    core.stop()
    tools.reset()
    forwarding.close()
    const ok = !error && checks.length > 0 && checks.every((one) => one.ok)
    console.log(`LITCH_TOOLS_REMOTE ${JSON.stringify({ ok, checks, ...(error ? { error } : {}) })}`)
    setTimeout(() => app.exit(ok ? 0 : 1), 300)
  }

  try {
    let device: DeviceView | null = null
    core.subscribe(
      { kind: 'app' },
      {
        snapshot: (data) => {
          device = (data as { devices: DeviceView[] }).devices[0] ?? null
        },
        delta(ops) {
          for (const op of ops as { op: string; device?: DeviceView }[]) {
            if (op.op === 'device.upsert' && op.device) device = op.device
          }
        },
        error() {},
      },
    )
    core.start()
    await until('设备连上', () => (device as DeviceView | null)?.connection === 'online', 120_000)
    const mode = (device as DeviceView | null)?.mode
    check('连的是完整的设备服务', mode === 'full', mode)

    const session = { view: null as SessionView | null }
    const texts = () =>
      Object.values(session.view?.items ?? {}).flatMap((item) =>
        item.kind === 'agentMessage' ? [item.text] : [],
      )
    const settled = () =>
      session.view !== null &&
      session.view.turns.length > 0 &&
      session.view.turns.every((turn) => turn.status !== 'running')

    // 1. 回声
    const { sessionId } = (await core.command(
      'session.create',
      { deviceId, harness: 'pi', cwd: work, text: '回声 LITCH-ECHO-R1' },
      never,
    )) as { sessionId: string }
    core.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot: (data) => {
          session.view = structuredClone(data) as SessionView
        },
        delta(ops) {
          for (const op of ops as SessionOp[]) {
            if (session.view) reduceSession(session.view, structuredClone(op))
          }
        },
        error: (error) => console.error(`[probe] 会话出错：${String(error.message)}`),
      },
    )
    await until(
      '回声的回话',
      () => texts().some((text) => text.includes('LITCH-ECHO-R1')) && settled(),
    )
    check(
      'litch_echo 经设备服务和 ssh 回到桌面，结果回到模型',
      texts().some((text) => text.includes('回声结果：LITCH-ECHO-R1')),
      texts(),
    )

    // 2. 浏览远端 localhost
    const browse = async (mark: string) => {
      const before = texts().length
      await core.command(
        'session.send',
        {
          deviceId,
          sessionId,
          text: `浏览 http://localhost:${webPort}/go 等字：HMR-OK ${mark}`,
        },
        never,
      )
      await until(
        `${mark} 的回话`,
        () => texts().length > before && texts().at(-1)?.includes('浏览结果：') && settled(),
      )
      return texts().at(-1) ?? ''
    }
    const said = await browse('LITCH-BROWSE-1')
    if (process.env.LITCH_CHECK_DEBUG) console.error(`[probe] 模型说：\n${said}`)
    const [forward] = forwarding.forwarder.list()
    check(
      '起了一条转发，本机端口和远端端口不同',
      !!forward && forward.remotePort === webPort && forward.localPort !== webPort,
      forwarding.forwarder.list(),
    )
    const localPort = forward?.localPort ?? -1
    check(
      '给模型的结果说明了远端地址经 ssh 转到了桌面的哪个端口',
      said.includes(`remote device's localhost:${webPort}, forwarded over ssh`) &&
        said.includes(`localhost:${localPort}`),
      said,
    )
    check(
      '重定向到远端的绝对地址也改写到了转发上',
      said.includes(`localhost:${localPort}/second`),
      said,
    )
    check('页面打开了（快照里有页面上的字）', said.includes('LITCH-REMOTE-PAGE'), said)
    check('页面里的 WebSocket（热更新那种）经转发连上了', said.includes('Found.'), said)
    const log = (await (await fetch(`http://127.0.0.1:${webPort}/__log`)).json()) as Array<{
      path: string
      host: string
    }>
    check(
      '远端网页收到的请求都来自转发（Host 是桌面的本机端口）',
      log.length >= 3 && log.every((entry) => entry.host === `localhost:${localPort}`),
      log,
    )
    check(
      '远端网页收到了页面、重定向后的页面和 WebSocket',
      ['/go', '/second', '/hmr'].every((path) => log.some((entry) => entry.path === path)),
      log,
    )

    // 3. 转发的 ssh 没了：重建，还是原来的本机端口
    const shPid = forward?.pid ?? -1
    const [sshPid] = sshUnder(shPid)
    check('转发的 ssh 是应用自己的子孙进程', !!sshPid, { shPid })
    if (sshPid) process.kill(sshPid, 'SIGKILL')
    await until('转发的 ssh 退了', () => !sshPid || !alive(sshPid), 10_000)
    const again = await browse('LITCH-BROWSE-2')
    const [rebuilt] = forwarding.forwarder.list()
    check(
      'ssh 退了之后转发重建，本机端口不变',
      !!rebuilt &&
        rebuilt.localPort === localPort &&
        rebuilt.running &&
        again.includes('LITCH-REMOTE-PAGE'),
      { rebuilt, again },
    )

    // 4. 撤掉：ssh 跟着退
    const [lastSsh] = sshUnder(rebuilt?.pid ?? -1)
    forwarding.close()
    await until('撤掉之后 ssh 退了', () => !lastSsh || !alive(lastSsh), 10_000)
    check('撤掉转发之后 ssh 退了', !!lastSsh && !alive(lastSsh), { lastSsh })
    finish()
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error))
  }
})
