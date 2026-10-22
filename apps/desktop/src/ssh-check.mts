// 开发和自检用的小工具：不起界面，直接拿远程传输连一台设备，把走过的每一步和最后的结果各打一行 JSON。
// 自检脚本（scripts/check-ssh.mjs）拿它对着假的远程机器把每一种情形过一遍。
//
// 用法：node dist/ssh-check.mjs '<连接配置的 JSON>' [--probe | --hold]
//   默认：打开传输、握手、问一句对面是谁、列一次会话，然后断开。连上了退出码是 0，没连上是 1。
//     结果里的 mode 是对面的种类：full 是设备服务的聚合面（带着上面的 harness），single 是单个 harness。
//     每一行带着 at：从这次运行开始算起过了多少毫秒，量各步耗时用。
//   --probe：只做添加设备之前的那一眼检查，不启动任何东西。
//   --hold：连上之后不断开，一直等到连接自己断掉，把断开的原因打出来（验心跳用）。
//   --inspect：一键升级的“看一眼装着的是哪一份”（ssh/upgrade.mts），打一行结果。
//   --install <script|brew> <版本>：一键升级的“装这一版”，打一行结果。不经确认，只给自检用。
//   --stop [--force]：一键升级的“请服务停下”（默认 --if-idle），打一行结果。
// 另：node dist/ssh-check.mjs --discover 列出 ssh 配置里发现到的主机；
//     node dist/ssh-check.mjs --store <目录> 把设备配置和侧栏快照在那个目录里存取一遍。
import {
  type Clock,
  createLink,
  describeText,
  isDeviceRuntime,
  type RemoteTarget,
} from '@litch/core'
import { fileDeviceStore } from './device-store.mjs'
import { discoverHosts } from './ssh/hosts.mjs'
import { remoteUpgrade } from './ssh/upgrade.mjs'
import { checkRemote, sshOpener } from './transport-ssh.mjs'

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

const began = Date.now()
const say = (line: Record<string, unknown>) =>
  console.log(JSON.stringify({ ...line, at: Date.now() - began }))

if (process.argv[2] === '--discover') {
  say({ hosts: await discoverHosts() })
  process.exit(0)
}

if (process.argv[2] === '--store') {
  const dir = process.argv[3] ?? ''
  const store = fileDeviceStore(dir)
  const empty = store.load()
  store.save({
    localWire: 'violet',
    remotes: [
      { id: 'ssh-1', name: '构建机', target: { kind: 'alias', alias: 'build-01' }, wire: 'blue' },
    ],
  })
  const snapshot = store.snapshot('ssh-1')
  const before = snapshot.load()
  snapshot.save({
    mode: 'single',
    harnesses: [],
    workspaces: [],
    sections: [],
    threads: [{ id: 't1' } as never],
    unread: [],
  })
  const after = fileDeviceStore(dir).snapshot('ssh-1').load()
  store.forget('ssh-1')
  say({
    empty,
    saved: fileDeviceStore(dir).load(),
    before,
    threads: after?.threads.map((thread) => thread.id),
    forgotten: fileDeviceStore(dir).snapshot('ssh-1').load(),
  })
  process.exit(0)
}

const target = JSON.parse(process.argv[2] ?? 'null') as RemoteTarget
const hold = process.argv.includes('--hold')

/** 一键升级在远端做的那三件事，各跑一次就退出。远端命令行说中文，自检按中文的原话认 */
const upgradeAt = ['--inspect', '--install', '--stop'].find((flag) => process.argv.includes(flag))
if (upgradeAt) {
  const platform = remoteUpgrade(() => 'zh-CN')
  const signal = new AbortController().signal
  const value = (flag: string, offset = 1) =>
    process.argv[process.argv.indexOf(flag) + offset] ?? ''
  try {
    if (upgradeAt === '--inspect') say({ facts: await platform.inspect(target, signal) })
    else if (upgradeAt === '--install') {
      const method = value('--install') === 'brew' ? 'brew' : 'script'
      say({
        install: await platform.install(target, { method, version: value('--install', 2) }, signal),
      })
    } else say({ stop: await platform.stop(target, !process.argv.includes('--force'), signal) })
    process.exit(0)
  } catch (error) {
    say({ error: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  }
}

if (process.argv.includes('--probe')) {
  const result = await checkRemote(target, new AbortController().signal)
  say(
    result.ok
      ? {
          result: 'ok',
          peer: result.peer,
          version: result.version,
          system: result.system,
          ...(result.peer === 'service'
            ? {
                running: result.running,
                harnesses: result.harnesses?.map((harness) => `${harness.id}:${harness.state}`),
              }
            : {}),
        }
      : {
          result: 'failed',
          stage: result.failure.stage,
          text: describeText(result.failure.text),
          detail: result.failure.detail,
          guide: result.failure.guide ?? null,
        },
  )
  process.exit(result.ok ? 0 : 1)
}

let wasConnected = false
const done = (code: number, waitMs = 300) => {
  link.stop()
  // 留一点时间让 ssh 子进程收尾
  setTimeout(() => process.exit(code), waitMs)
}

const link = createLink({
  open: sshOpener(target),
  clock,
  clientInfo: { name: 'litch-ssh-check', title: 'Litch', version: '0.0.0' },
  notification() {},
  state(state) {
    if (state.phase === 'connecting' && state.step) {
      say({ step: describeText(state.step) })
    } else if (hold && wasConnected && state.phase === 'waiting') {
      say({ closed: describeText(state.failure.text) })
      // 卡死的 ssh 要等到强行结束的那一下，这里多留几秒
      done(0, 3500)
    } else if (state.phase === 'waiting' || state.phase === 'failed') {
      // 这里只试一次，不等它自己重连
      say({
        result: 'failed',
        stage: state.failure.stage,
        text: describeText(state.failure.text),
        detail: state.failure.detail,
        guide: state.failure.guide ?? null,
        retriable: state.phase === 'waiting',
      })
      done(1)
    } else if (state.phase === 'connected') {
      wasConnected = true
      if (hold) {
        say({ result: 'ok', holding: true })
        return
      }
      const ask = async () => {
        // 对面是谁：认识 runtime/info 而且报了设备和 harness 的是设备服务的聚合面
        const info = await link.request('runtime/info', {}).catch(() => null)
        const device = info && isDeviceRuntime(info) ? info : null
        const list = await link.request('thread/list', { limit: 100 })
        say({
          result: 'ok',
          userAgent: state.info.userAgent,
          mode: device ? 'full' : 'single',
          harnesses: device?.harnesses.map(
            (harness) => `${harness.id}:${harness.available ? 'ready' : 'down'}`,
          ),
          extensions: device?.device.extensions ?? [],
          threads: list.data.length,
        })
      }
      ask().then(
        () => done(0),
        (error: unknown) => {
          say({ result: 'failed', stage: 'request', text: String(error) })
          done(1)
        },
      )
    }
  },
})
link.start()
