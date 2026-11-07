// 只被 check-updater-mac.mjs 打进独立签名夹具，不随应用发布；不载入设备服务或用户界面。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { createUpdater } from '../src/updater.mjs'

const config = JSON.parse(process.env.LITCH_UPDATE_PROBE ?? 'null') as {
  root: string
  profile: string
  identifier: string
  scenario: string
}
if (!config?.root || !config.profile || !config.identifier.startsWith('dev.litch.updater-probe-')) {
  throw new Error('只允许隔离更新夹具启动')
}
app.setPath('userData', config.profile)
void app.whenReady().then(run)

async function run(): Promise<void> {
  const states: unknown[] = []
  const logs: string[] = []
  const evidence: Record<string, unknown> = { scenario: config.scenario, states, logs }
  let version = '1.0.1'
  let failure = ''
  let checkingOld: Promise<void> = Promise.resolve()
  const stateFile = join(
    app.getPath('home'),
    'Library/Caches',
    `${config.identifier}.ShipIt`,
    'ShipItState.plist',
  )
  const staged = () => {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    return readFileSync(
      join(fileURLToPath(state.updateBundleURL), 'Contents/Resources/update-marker'),
      'utf8',
    )
  }
  const server = createServer((request, response) => {
    if (request.url === '/feed') {
      const zip = join(config.root, failure === 'signature' ? 'invalid.zip' : `${version}.zip`)
      const bytes = readFileSync(zip)
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          version,
          assets: {
            'macos-arm64': {
              url: `http://127.0.0.1:${(server.address() as { port: number }).port}/package`,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          },
        }),
      )
      return
    }
    if (request.url !== '/package') {
      response.writeHead(404).end()
      return
    }
    if (version === '1.0.2') {
      // 原生已经开始重建/清理并请求新包时，ShipIt 的旧安装来源必须仍然存在。
      checkingOld = Promise.resolve().then(() => assert.equal(staged(), '1.0.1'))
    }
    if (failure === 'network') {
      response.writeHead(503).end()
      return
    }
    if (failure === 'not-available') {
      response.writeHead(304).end()
      return
    }
    const path = join(config.root, failure === 'signature' ? 'invalid.zip' : `${version}.zip`)
    response.setHeader('Content-Type', 'application/zip')
    createReadStream(path).pipe(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const updater = createUpdater({
    version: '1.0.0',
    platform: 'macos-arm64',
    dataDir: config.profile,
    feedUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/feed`,
    allowHttp: true,
    auto: () => true,
    onState: (state) => {
      states.push(state)
      console.log(JSON.stringify(state))
    },
    log: (line) => {
      logs.push(line)
      console.log(line)
    },
  })
  try {
    await updater.check()
    assert.equal(updater.state().phase, 'ready')
    assert.equal(staged(), '1.0.1')
    version = '1.0.2'
    for (const reason of ['network', 'network', 'signature', 'signature', 'not-available']) {
      failure = reason
      await updater.check()
      await checkingOld
      assert.deepEqual(updater.state(), { phase: 'ready', version: '1.0.1', notesUrl: '' })
      assert.equal(staged(), '1.0.1')
    }
    if (config.scenario === 'success') {
      failure = ''
      await updater.check()
      await checkingOld
      assert.deepEqual(updater.state(), { phase: 'ready', version: '1.0.2', notesUrl: '' })
      assert.equal(staged(), '1.0.2')
    }
    evidence.ok = true
    evidence.staged = staged()
  } catch (error) {
    evidence.ok = false
    evidence.error = String(error)
    console.error(error)
  } finally {
    evidence.home = app.getPath('home')
    writeFileSync(join(config.profile, 'evidence.json'), JSON.stringify(evidence, null, 2))
    updater.stop()
    server.close()
    // 普通退出让真实 ShipIt 安装，不重开夹具，避免丢失隔离变量。
    app.quit()
  }
}
