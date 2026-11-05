// iOS Maestro 使用的隔离夹具辅助口；只接 fixture.mjs 创建的临时 sshd，不接受真实设备配置。
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encodePairPayload } from '../../../packages/protocol/src/device-pairing.mts'
import { deviceRpc } from './device-rpc.mjs'
import { terminalEvidence } from './terminal-audit.mjs'

export async function iosTestHelper(config, artifacts, simulator) {
  if (!/^\/tmp\/litch-ssh-[^/]+$/.test(config.root)) throw new Error('必须使用隔离 SSH 夹具')
  if (!/^[0-9A-F-]{36}$/.test(simulator)) throw new Error('必须指定隔离模拟器')
  let rpc
  let current
  let policyLog
  let policyBuffer = ''
  let policies = []
  let backgrounded = false
  const simctl = (...args) =>
    execFileSync('xcrun', ['simctl', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  const clipboard = new Map()
  const service = async () => {
    if (rpc) return rpc
    const said = execFileSync(
      'ssh',
      ['-F', join(config.root, 'ssh_config'), '-o', 'BatchMode=yes', 'litch-fx-svc', 'exec sh'],
      {
        input: `exec "$SHELL" -l -i -c '${config.adapter} device-start --ssh=off'\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 60_000,
      },
    )
    const ready = said
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((line) => line.ready)
    if (!ready) throw new Error('隔离设备服务未就绪')
    rpc = await deviceRpc(ready.socket)
    return rpc
  }
  const pair = async (method, path) => {
    const device = await service()
    if (method === 'POST' && path === '/pair') {
      const { data } = await device.call('litch/pair/phones', {})
      for (const phone of data) await device.call('litch/pair/revoke', { phoneId: phone.phoneId })
      const start = await device.call('litch/pair/start', {})
      current = start.pairId
      return encodePairPayload({
        v: 1,
        n: 'e2e-pair',
        h: '127.0.0.1',
        p: config.target.port,
        u: config.target.user,
        k: { t: start.hostKey.type, f: start.hostKey.fingerprint },
        s: start.seed,
        i: start.pairId,
        e: start.expiresAt,
        a: 1,
      })
    }
    if (path === '/pair/phones') {
      const { data } = await device.call('litch/pair/phones', {})
      const keyLines = readFileSync(join(config.root, 'authorized_keys'), 'utf8')
        .split('\n')
        .filter((line) => line.includes(' litch-mobile:')).length
      return JSON.stringify({ phones: data.length, keyLines })
    }
    if (path === '/pair/request') {
      const result = await device.call(
        'litch/pair/wait',
        { pairId: current, since: 'waiting' },
        40_000,
      )
      return result.state === 'requested' ? JSON.stringify(result.phone) : null
    }
    if (path === '/pair/allow') {
      const result = await device.call('litch/pair/decide', { pairId: current, allow: true })
      return result.state === 'done' ? 'ok' : null
    }
    return null
  }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (part) => {
      body += part
    })
    request.on('end', async () => {
      try {
        const url = new URL(request.url, 'http://localhost')
        let answer = null
        if (url.pathname === '/background/start' && request.method === 'POST') {
          policies = []
          policyBuffer = ''
          simctl(
            'spawn',
            simulator,
            'log',
            'config',
            '--subsystem',
            'dev.litch.connection',
            '--mode',
            'level:info',
          )
          policyLog = spawn('xcrun', [
            'simctl',
            'spawn',
            simulator,
            'log',
            'stream',
            '--style',
            'compact',
            '--level',
            'debug',
            '--predicate',
            'subsystem == "dev.litch.connection"',
          ])
          policyLog.stdout.on('data', (chunk) => {
            policyBuffer += chunk.toString()
            let newline
            while ((newline = policyBuffer.indexOf('\n')) >= 0) {
              const line = policyBuffer.slice(0, newline)
              policyBuffer = policyBuffer.slice(newline + 1)
              const state = /Connection policy: (\{.*\})/.exec(line)
              if (state) policies.push(JSON.parse(state[1]))
            }
          })
          await sleep(1000)
          simctl('launch', simulator, 'com.apple.Preferences')
          backgrounded = true
          answer = 'ok'
        } else if (url.pathname === '/background/status') {
          if (!policies.some((state) => state.suspended)) await sleep(10_000)
          answer = JSON.stringify({ paused: policies.some((state) => state.suspended), policies })
        } else if (url.pathname === '/background/resume' && request.method === 'POST') {
          simctl('launch', simulator, 'dev.litch.app.dev')
          backgrounded = false
          for (let i = 0; i < 40 && policies.at(-1)?.background !== false; i++) await sleep(250)
          answer = JSON.stringify({ resumed: policies.at(-1)?.background === false, policies })
        } else if (url.pathname === '/clipboard/set' && request.method === 'POST') {
          execFileSync('xcrun', ['simctl', 'pbcopy', simulator], { input: body })
          answer = 'ok'
        } else if (url.pathname.startsWith('/pair'))
          answer = await pair(request.method, url.pathname)
        else if (
          url.pathname === '/authorize' &&
          request.method === 'POST' &&
          /^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/.test(body.trim())
        ) {
          appendFileSync(join(config.root, 'authorized_keys'), `${body.trim()}\n`)
          answer = 'ok'
        } else if (url.pathname === '/terminal-evidence') {
          answer = JSON.stringify(terminalEvidence(config, artifacts))
        } else if (url.pathname === '/file') {
          const name = url.searchParams.get('name') ?? ''
          if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('无效夹具文件名')
          for (let i = 0; i < 40; i++) {
            const file = join(config.work, name)
            if (
              existsSync(file) &&
              readFileSync(file, 'utf8').includes(url.searchParams.get('text') ?? '')
            ) {
              answer = 'ok'
              break
            }
            await sleep(250)
          }
        } else if (url.pathname === '/clipboard/result') {
          const id = url.searchParams.get('id')
          if (request.method === 'POST') {
            clipboard.set(id, JSON.parse(body))
            answer = 'ok'
          } else {
            for (let i = 0; i < 40 && !clipboard.has(id); i++) await sleep(250)
            if (clipboard.has(id)) {
              answer = JSON.stringify(clipboard.get(id))
              clipboard.delete(id)
            }
          }
        }
        response.writeHead(answer === null ? 404 : 200).end(answer ?? '')
      } catch (error) {
        console.error(error.message)
        response.writeHead(500).end('隔离测试辅助口失败')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      if (backgrounded) simctl('launch', simulator, 'dev.litch.app.dev')
      if (policyLog) policyLog.kill('SIGTERM')
      rpc?.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
