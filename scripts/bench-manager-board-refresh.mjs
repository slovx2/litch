// 答复到整板刷新：真实设备管理模块 + 核心 manager 投影，经 WebSocket / OpenSSH。
// node scripts/bench-manager-board-refresh.mjs /tmp/manager-board.json [基线提交]
// 旧实现由 esbuild 从 git 只读取出到临时 bundle；不切分支、不覆盖源码或 dist。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket, WebSocketServer } from 'ws'
import { until } from './chrome-m0/cdp.mjs'
import { managerBoardUiServer } from './manager-board-ui-server.mjs'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const baseline = process.argv.slice(3).find((arg) => !arg.startsWith('--')) ?? '167020f1'
const ui = process.argv.includes('--ui')
const repo = resolve(import.meta.dirname, '..')
const modified = [
  'packages/core/src/device/manager.mts',
  'packages/device/src/manager.mts',
  'packages/device/src/manager-posts.mts',
]
mkdirSync(join(repo, '.artifacts'), { recursive: true })

async function modules(before) {
  const filename = join(repo, '.artifacts', `manager-refresh-${process.pid}-${before}.mjs`)
  const previous = new Map(
    before
      ? modified.map((name) => [
          join(repo, name),
          execFileSync('git', ['show', `${baseline}:${name}`], { cwd: repo, encoding: 'utf8' }),
        ])
      : [],
  )
  const plugins = [
    {
      name: 'manager-baseline',
      setup(builder) {
        builder.onResolve({ filter: /\.mjs$/ }, (args) => {
          if (!args.path.startsWith('.')) return
          const path = resolve(args.resolveDir, args.path.replace(/\.mjs$/, '.mts'))
          if (existsSync(path)) return { path }
        })
        builder.onLoad({ filter: /\.mts$/ }, (args) =>
          previous.has(args.path) ? { contents: previous.get(args.path), loader: 'ts' } : undefined,
        )
      },
    },
  ]
  const browser = await build({
    stdin: {
      contents: "export {createManagers} from './packages/core/src/device/manager.mts'",
      resolveDir: repo,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    plugins,
  })
  await build({
    stdin: {
      contents: `export {treeRig} from './packages/device/test/tree-kit.mts';
      export {createManagers} from './packages/core/src/device/manager.mts';`,
      resolveDir: repo,
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile: filename,
    plugins,
  })
  return {
    ...(await import(pathToFileURL(filename).href)),
    browser: browser.outputFiles[0].text,
    cleanup: () => unlinkSync(filename),
  }
}

async function measure(module, ssh) {
  const env = module.treeRig()
  const owner = env.device.managers
  const manager = {
    ...data.manager,
    cwd: env.stateDir,
    contact: { ...data.manager.contact, desktopNotification: false },
  }
  // 只测看板提交，不运行模型回合；入库、队列、计数和通知仍走生产实现。
  owner.kick = () => {}
  owner.store.saveManager(manager)
  owner.store.transaction(() => {
    for (const object of [...data.board.decisions, ...data.board.items])
      owner.store.saveObject(manager.id, object)
    const insert = owner.store.db.prepare('INSERT INTO changes(manager_id,body) VALUES(?,?)')
    for (const change of [...data.board.changes].reverse())
      insert.run(manager.id, JSON.stringify(change))
  })
  for (const line of data.board.lines)
    env.device.sessionTree.store.addLineage({
      threadId: line.threadId,
      parentThreadId: manager.threadId,
      harness: 'pi',
      kind: 'fresh',
      origin: 'model',
      title: line.title,
      prompt: '隔离工作线',
      wakeParent: false,
      createdAt: 1_800_000_000,
      proposalId: null,
    })
  env.device.sessionTree.read = async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { thread: { id, status: { type: 'idle' }, cwd: env.stateDir } }
  }
  const http = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/javascript',
      'Access-Control-Allow-Origin': '*',
    })
    response.end(module.browser)
  })
  const server = new WebSocketServer({ server: http })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const calls = []
  owner.tree.host.announce = (method, params) => {
    for (const socket of server.clients) socket.send(JSON.stringify({ method, params }))
  }
  server.on('connection', (socket) =>
    socket.on('message', async (raw) => {
      const { id, method, params } = JSON.parse(String(raw))
      calls.push(method)
      try {
        socket.send(JSON.stringify({ id, result: await owner.call(method, params, true) }))
      } catch (error) {
        socket.send(JSON.stringify({ id, error: String(error) }))
      }
    }),
  )
  let child
  let socket
  try {
    let port = server.address().port
    if (ssh) {
      child = spawn(
        process.execPath,
        [join(repo, 'scripts/bench-manager-board-transport.mjs'), '--forward', String(port)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let errors = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        errors += chunk
      })
      await until(() => {
        if (child.exitCode !== null) throw new Error(errors)
        return output.includes('\n')
      }, '临时 SSH')
      port = JSON.parse(output.trim()).port
    }
    if (ui) {
      const uiServer = await managerBoardUiServer(repo, port, http.address().port)
      const filename = join(repo, '.artifacts', `manager-refresh-ui-${process.pid}.json`)
      writeFileSync(
        filename,
        JSON.stringify({
          ...data,
          rpcUrl: `ws://127.0.0.1:${uiServer.port}/fixture-rpc`,
          coreUrl: `${uiServer.url}/fixture-core.mjs`,
        }),
      )
      try {
        const browser = spawn(
          process.execPath,
          [join(repo, 'scripts/check-manager-board-ui.mjs'), filename],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, LITCH_MANAGER_UI: uiServer.url },
          },
        )
        let output = ''
        let errors = ''
        browser.stdout.on('data', (chunk) => {
          output += chunk
        })
        browser.stderr.on('data', (chunk) => {
          errors += chunk
        })
        const code = await new Promise((resolve) => browser.once('exit', resolve))
        if (code !== 0) throw new Error(`界面基准失败：${errors}\n请求：${JSON.stringify(calls)}`)
        const { state } = JSON.parse(output.trim())
        return {
          ssh,
          submitReturnedMs: state.acceptedAt - state.startedAt,
          firstStatusPaintMs: state.statusPaintAt - state.startedAt,
          fullBoardPaintMs: state.fullPaintAt - state.startedAt,
          afterSuccessMs: state.fullPaintAt - state.acceptedAt,
          calls,
        }
      } finally {
        unlinkSync(filename)
        await uiServer.close()
      }
    }
    socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const pending = new Map()
    let nextId = 0
    const core = module.createManagers({
      deviceId: 'local',
      online: () => true,
      supported: () => true,
      features: () => ({ feedback: true, posts: true, ignore: true }),
      changed() {},
      log: console.error,
      fail: (error) => error,
      request(method, params) {
        return new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, { resolve, reject })
          socket.send(JSON.stringify({ id, method, params }))
        })
      },
    })
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.id) {
        const entry = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.error) entry.reject(new Error(frame.error))
        else entry.resolve(frame.result)
      } else core.notification(frame.method, frame.params)
    })
    let view
    let start = 0
    let firstAnsweredMs
    let fullBoardMs
    const apply = (next) => {
      view = next
      if (!start || next.board?.decisions.find((d) => d.id === 'D-1')?.status !== 'answered') return
      firstAnsweredMs ??= performance.now() - start
      if (next.board.changes.length === data.board.changes.length + 1)
        fullBoardMs ??= performance.now() - start
    }
    const close = core.openBoard(manager.id, {
      snapshot: apply,
      delta: (ops) => {
        for (const op of ops) apply(op.view)
      },
      error: console.error,
    })
    await until(() => view?.board, '初始整板', 60000)
    calls.length = 0
    start = performance.now()
    await core.submit(manager.id, [
      { decisionId: 'D-1', revision: 16, optionId: null, text: '批准执行' },
    ])
    const submitReturnedMs = performance.now() - start
    await until(() => fullBoardMs, '完整看板刷新', 120000)
    assert.equal(view.board.changes[0].after.status, 'answered')
    assert.equal(view.board.decisions.find((d) => d.id === 'D-1').answer.text, '批准执行')
    assert.equal(view.board.posts.find((p) => p.id === 'D-1').revision, 17)
    close()
    core.offline()
    return {
      ssh,
      submitReturnedMs,
      firstAnsweredMs,
      fullBoardMs,
      afterSuccessMs: fullBoardMs - submitReturnedMs,
      calls,
    }
  } finally {
    if (socket) {
      socket.close()
      await new Promise((resolve) => socket.once('close', resolve))
    }
    if (child) {
      child.kill()
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    }
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => http.close(resolve))
    await env.close()
  }
}

for (const before of [true, false]) {
  const module = await modules(before)
  try {
    for (const ssh of [false, true])
      console.log(JSON.stringify({ before, ...(await measure(module, ssh)) }))
  } finally {
    module.cleanup()
  }
}
