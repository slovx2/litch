// 双端夹具结束后在同一个隔离 Linux HOME 启动正式设备聚合面。Codex 用真 app-server 和回环假模型，Pi 用正式反向调用入口。
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  codexConfig,
  codexSocketCleanup,
  startResponsesModel,
  userText,
} from '../client-fixture-responses.mjs'

export async function checkRemoteChromeEngines({ repo, home, stateDir, binary, wait, terminate }) {
  const codexCli = process.env.LITCH_FIXTURE_CODEX
  if (!codexCli) return
  const work = join(home, 'work')
  const codexHome = join(home, 'codex')
  await Promise.all([mkdir(work, { recursive: true }), mkdir(codexHome, { recursive: true })])
  process.env.CODEX_HOME = codexHome
  process.env.PI_CODING_AGENT_DIR = join(home, 'pi')
  process.env.PI_CLI = join(
    repo,
    'packages/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  )
  const dist = join(repo, 'packages/device/dist/packages')
  const { DeviceServer } = await import(join(dist, 'device/src/device.mjs'))
  const { listenUnix, unixConnector } = await import(join(dist, 'device/src/sockets.mjs'))
  const { clientToolSpecs } = await import(join(dist, 'protocol/src/client-tools-specs.mjs'))
  const { PiServer } = await import(join(repo, 'packages/pi/dist/pi/src/server.mjs'))

  let codexTargets
  const model = await startResponsesModel((body) => {
    if (!userText(body).startsWith('Call Chrome targets')) return { text: 'Chrome fixture' }
    const result = body.input?.findLast((item) => item.type === 'function_call_output')
    if (!result) return { call: { namespace: 'litch_browser', name: 'targets', arguments: '{}' } }
    codexTargets = result.output
    return { text: 'Chrome targets checked' }
  })
  await writeFile(join(codexHome, 'config.toml'), codexConfig(model.baseUrl))
  const socket = join(home, 'codex.sock')
  const codex = spawn(codexCli, ['app-server', '--listen', `unix://${socket}`], {
    cwd: work,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  codex.stderr.on('data', (chunk) => {
    if (process.env.LITCH_FIXTURE_VERBOSE) process.stderr.write(chunk)
  })
  const pi = new PiServer(join(home, 'pi-runtime'))
  const piPeers = []
  const piConnector = async (handlers) => {
    const peer = {
      id: randomUUID(),
      close() {},
      send(frame) {
        queueMicrotask(() => handlers.message(JSON.stringify(frame)))
      },
    }
    piPeers.push(peer)
    return {
      send(raw) {
        const frame = JSON.parse(raw)
        if (frame.method === 'initialize') peer.client = frame.params.clientInfo.name
        queueMicrotask(() => void pi.handle(peer, frame))
      },
      close() {
        pi.closePeer(peer)
        handlers.close('closed')
      },
    }
  }
  let device,
    deviceListener,
    background,
    unlinkCodexSocket = () => {}
  try {
    await wait(
      () =>
        stat(socket).then(
          () => true,
          () => false,
        ),
      'Codex app-server',
    )
    unlinkCodexSocket = codexSocketCleanup(socket)
    device = new DeviceServer({
      stateDir,
      chromeBinary: binary,
      upstreams: [
        { id: 'codex', native: true, connect: unixConnector(socket) },
        { id: 'pi', connect: piConnector },
      ],
      log: (line) => {
        if (process.env.LITCH_FIXTURE_VERBOSE) console.log(line)
      },
    })
    deviceListener = await listenUnix(join(stateDir, 'device.sock'), (wire) => device.attach(wire))
    const newClient = connect(device)
    const oldClient = connect(device)
    const desktopCalls = []
    newClient.request = async (method, params) => {
      assert.equal(method, 'item/tool/call')
      desktopCalls.push(params)
      return fetch('http://fixture-controller:31772', {
        method: 'POST',
        body: JSON.stringify(params),
      }).then((reply) => reply.json())
    }
    await newClient.rpc('initialize', {
      clientInfo: { name: 'fixture-desktop', version: '1' },
      capabilities: {
        experimentalApi: true,
        litchExtensions: ['harness', 'clientTools', 'remoteChrome'],
        litchClientTools: {
          namespaces: ['litch_browser'],
          browserActions: true,
          chromeTargetRouting: 1,
        },
      },
    })
    await oldClient.rpc('initialize', {
      clientInfo: { name: 'fixture-legacy', version: '1' },
      capabilities: { experimentalApi: true, litchExtensions: ['harness', 'clientTools'] },
    })
    const status = await wait(async () => {
      const reply = await newClient.rpc('litch/remoteChrome/status', {})
      return reply.condition === 'connected' && reply
    }, 'production device status')
    assert.match(status.prepareCommand, /chrome prepare/)
    const chrome = async (...args) =>
      JSON.parse(
        (
          await promisify(execFile)(binary, [
            'chrome',
            ...args,
            '--root',
            repo,
            '--home',
            join(home, 'adapter'),
          ])
        ).stdout,
      )
    assert.equal((await chrome('status')).bridge.condition, 'connected')
    await assert.rejects(
      newClient.rpc('litch/remoteChrome/configure', { action: 'trust-on' }),
      /Chrome user’s terminal/,
    )
    assert.equal((await chrome('sites')).trustAll, false)
    assert.deepEqual((await chrome('block', 'localhost')).blocked, ['localhost'])
    assert.equal((await chrome('trust-on')).trustAll, true)
    assert.equal(
      (await oldClient.rpc('runtime/info', {})).device.extensions.includes('remoteChrome'),
      false,
    )
    await assert.rejects(oldClient.rpc('litch/remoteChrome/status', {}), /must be declared/)

    const start = await newClient.rpc('thread/start', {
      harness: 'codex',
      cwd: work,
      dynamicTools: clientToolSpecs(['litch_browser']),
    })
    await newClient.rpc('turn/start', {
      threadId: start.thread.id,
      input: [{ type: 'text', text: 'Call Chrome targets' }],
    })
    await wait(() => codexTargets, 'native Codex receive Chrome targets')
    assert.match(JSON.stringify(codexTargets), /sessionDevice/)
    assert.match(JSON.stringify(codexTargets), /controller/)
    assert.ok(desktopCalls.some((call) => Array.isArray(call.litchChromeTargets)))
    console.log('CODEx_REMOTE_CHROME_OK: real app-server received both Chrome targets')

    // Pi 的正式 Server.call 走真实的内部动态工具选路和反向 RPC；这里不启动模型。
    const piPeer = await wait(
      () => piPeers.find((peer) => peer.client === 'fixture-desktop'),
      'Pi upstream',
    )
    pi.subscribe(piPeer, 'pi-fixture-thread')
    const piResult = await pi.call(piPeer, 'pi-fixture-thread', 'item/tool/call', {
      turnId: 'pi-fixture-turn',
      callId: 'pi-targets',
      namespace: 'litch_browser',
      tool: 'targets',
      arguments: {},
    })
    assert.equal(piResult.success, true, JSON.stringify(piResult))
    assert.match(piResult.contentItems[0].text, /sessionDevice/)
    assert.match(piResult.contentItems[0].text, /controller/)
    const deviceTarget = JSON.parse(piResult.contentItems[0].text).targets.find(
      (item) => item.location === 'sessionDevice',
    ).targetId
    const local = await pi.call(piPeer, 'pi-fixture-thread', 'item/tool/call', {
      turnId: 'pi-fixture-turn',
      callId: 'pi-blocked',
      namespace: 'litch_browser',
      tool: 'navigate',
      arguments: { targetId: deviceTarget, url: 'http://localhost:31770' },
    })
    assert.equal(local.success, false, JSON.stringify(local))
    assert.match(local.contentItems[0].text, /block/)
    assert.equal((await chrome('trust-off')).trustAll, false)
    console.log('PI_REMOTE_CHROME_OK: real Pi reverse tool request received both Chrome targets')
    newClient.close()
    oldClient.close()
    codexTargets = undefined
    background = await device.openEngineLink('codex')
    const session = await background.request('thread/start', {
      cwd: work,
      dynamicTools: clientToolSpecs(['litch_browser']),
    })
    await background.request('turn/start', {
      threadId: session.thread.id,
      input: [{ type: 'text', text: 'Call Chrome targets without desktop' }],
    })
    await wait(() => codexTargets, 'background Codex Chrome targets')
    assert.match(JSON.stringify(codexTargets), /sessionDevice/)
    assert.doesNotMatch(JSON.stringify(codexTargets), /"location":"controller"/)
    console.log('BACKGROUND_CHROME_OK: device Chrome discovery with no desktop connection')
  } finally {
    background?.close()
    await deviceListener?.close()
    await device?.close()
    await pi.close()
    await terminate(codex)
    unlinkCodexSocket()
    model.close()
  }
}

function connect(device) {
  let requestId = 0
  const pending = new Map()
  const client = {
    close: () => input.close('fixture disconnected'),
    async request(method) {
      throw new Error(`Unexpected client tool request: ${method}`)
    },
    rpc(method, params) {
      const id = ++requestId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        input.message(JSON.stringify({ id, method, params }))
      })
    },
  }
  const input = device.attach({
    send(raw) {
      const frame = JSON.parse(raw)
      if (frame.method && frame.id != null) {
        void client.request(frame.method, frame.params).then(
          (result) => input.message(JSON.stringify({ id: frame.id, result })),
          (error) =>
            input.message(
              JSON.stringify({ id: frame.id, error: { code: -32603, message: String(error) } }),
            ),
        )
      } else {
        const done = pending.get(frame.id)
        if (!done) return
        pending.delete(frame.id)
        if (frame.error) done.reject(new Error(frame.error.message))
        else done.resolve(frame.result)
      }
    },
    close() {},
  })
  return client
}
