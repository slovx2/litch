// M0 夹具编排：命令文件只送给本脚本启动的夹具；每条真实输入由独立授权应用执行。
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const source = dirname(fileURLToPath(import.meta.url))
const operation = process.argv[2]
const root = resolve(process.argv[3] ?? '/tmp/litch-cu-m0')
const built = resolve(source, '../../.artifacts/background')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const write = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value))
  renameSync(`${file}.tmp`, file)
}
async function waitFor(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const value = fn()
      if (value) return value
    } catch {}
    await delay(50)
  }
  throw new Error('等待夹具超时')
}
async function command(name, action) {
  const id = randomUUID()
  write(join(root, name, 'command.json'), { id, action })
  if (action !== 'quit') await waitFor(() => read(join(root, name, 'state.json')).commandID === id)
  await delay(150)
}
function openFixture(name, role) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  execFileSync('open', [
    '-n',
    '-g',
    join(built, 'Litch Background Fixture.app'),
    '--args',
    '--directory',
    directory,
    '--role',
    role,
  ])
}

if (operation === 'setup') {
  if (existsSync(join(root, 'permissions.json'))) throw new Error('本轮目录已经使用过，请选新目录')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  openFixture('appkit', 'target')
  openFixture('guard', 'guard')
  const directory = join(root, 'electron')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const electron = process.env.LITCH_PROBE_ELECTRON
  if (!electron) throw new Error('LITCH_PROBE_ELECTRON 必须指向已安装的 Electron 可执行文件')
  const environment = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex') }
  delete environment.ELECTRON_RUN_AS_NODE
  mkdirSync(environment.HOME, { recursive: true, mode: 0o700 })
  // 没有开启 CDP 端口。夹具只靠本地文件和固定 preload 回传状态。
  const child = spawn(electron, [join(source, 'electron.cjs'), '--directory', directory], {
    env: environment,
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  execFileSync('open', [
    '-n',
    '-g',
    join(built, 'Litch Background Input Probe.app'),
    '--args',
    '--directory',
    root,
  ])
  for (const name of ['appkit', 'guard', 'electron'])
    await waitFor(() => read(join(root, name, 'state.json')).pid)
  const permissions = await waitFor(() => read(join(root, 'permissions.json')))
  console.log(
    JSON.stringify(
      {
        root,
        permissions,
        fixtures: ['appkit', 'guard', 'electron'].map((name) => {
          const state = read(join(root, name, 'state.json'))
          return { name, pid: state.pid, text: state.text }
        }),
      },
      null,
      2,
    ),
  )
} else if (operation === 'matrix') {
  const permissions = read(join(root, 'permissions.json'))
  if (!permissions.accessibility || !permissions.eventPost)
    throw new Error('未授权，未执行任何输入')
  const reps = Number(process.env.LITCH_PROBE_REPETITIONS ?? '1')
  const backends = (
    process.env.LITCH_PROBE_BACKENDS ?? 'public,public-window,public-ax,private-focus,private'
  ).split(',')
  const targets = (process.env.LITCH_PROBE_TARGETS ?? 'appkit,electron').split(',')
  const warm = process.env.LITCH_PROBE_COLD !== '1'
  const runID = randomUUID()
  const results = []
  // 这一步仅建立测试前置状态，动作投递阶段禁止任何激活。
  await command('guard', 'activate')
  for (let repeat = 0; repeat < reps; repeat++) {
    for (const target of targets)
      for (const backend of backends) {
        for (const action of ['click', 'scroll', 'english', 'chinese', 'keycode']) {
          const live = read(join(root, 'permissions.json'))
          const ownedPids = targets
            .concat('guard')
            .map((name) => read(join(root, name, 'state.json')).pid)
          if (live.frontPid && !ownedPids.includes(live.frontPid))
            throw new Error('用户切到其他应用，已停止测试')
          await command(target, 'reset')
          await command(target, 'focusText')
          await command('guard', 'reset')
          if (warm) {
            await command(target, 'activate')
            await command('guard', 'activate')
          }
          const id = randomUUID()
          const request = { id, target, guard: 'guard', backend, action }
          write(join(root, 'request.json'), request)
          const result = await waitFor(() => {
            const r = read(join(root, 'response.json'))
            return r.id === id && r
          })
          const before = result.before ?? {},
            after = result.after ?? {}
          const guardPid = result.guardBefore?.pid
          const samples = result.samples ?? [],
            first = samples[0]
          const changed =
            action === 'click'
              ? after.clicks === (before.clicks ?? 0) + 1
              : action === 'scroll'
                ? after.scrollY > (before.scrollY ?? 0)
                : after.text ===
                  (action === 'english' ? 'abcXYZ' : action === 'chinese' ? '中文测试' : 'a')
          const summary = {
            target,
            backend,
            action,
            repeat,
            warm,
            changed,
            frontStable: samples.length > 0 && samples.every((s) => s.frontPid === guardPid),
            cursorMaxDistance: first
              ? Math.max(
                  ...samples.map((s) =>
                    Math.hypot(s.cursorX - first.cursorX, s.cursorY - first.cursorY),
                  ),
                )
              : null,
            guardText: result.guardAfter?.text,
            guardRouteOK:
              result.guardAfter?.text === 'v' && after.text === result.targetAfterInput?.text,
            error: result.error ?? null,
            actual:
              action === 'click' ? after.clicks : action === 'scroll' ? after.scrollY : after.text,
          }
          results.push({ summary, evidence: result })
          write(join(root, `matrix-${runID}.json`), { runID, permissions, results })
          console.log(JSON.stringify(summary))
          if (!summary.frontStable && !result.error?.includes('permission'))
            throw new Error('焦点变化，停止余下矩阵')
        }
      }
  }
  console.log(`完整证据：${join(root, `matrix-${runID}.json`)}`)
} else if (operation === 'stop') {
  for (const name of ['appkit', 'guard', 'electron']) {
    if (existsSync(join(root, name, 'state.json'))) await command(name, 'quit')
  }
  write(join(root, 'request.json'), { id: randomUUID(), action: 'quit' })
  console.log('已向本轮夹具和探针发送退出，不删除证据，不改系统授权。')
} else {
  throw new Error('用法：node run.mjs setup|matrix|stop /绝对路径/本轮状态目录')
}
