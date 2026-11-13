// 先构建设备包；CHA_CODEX_CLI 必须是隔离安装的官方 CLI。只连回环假模型。
// --expect-missing 用于修复前取证；完整三份协议证据留在 --output 指定目录。
// --screenshot 另需界面与 Electron 依赖；隐藏窗口直接连接本次设备，整页重开后截首屏和原图。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { WebSocket } from 'ws'
import { DeviceServer } from '../packages/device/dist/device/src/device.mjs'
import { listenUnix } from '../packages/device/dist/device/src/sockets.mjs'
import { TestClient } from '../packages/device/dist/device/test/helpers.mjs'
import { codexConfig, startResponsesModel } from './client-fixture-responses.mjs'

const cli = process.env.CHA_CODEX_CLI
assert.ok(cli, 'CHA_CODEX_CLI 必须指向隔离安装的 Codex')
const missing = process.argv.includes('--expect-missing')
const output = resolve(
  process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ??
    '.artifacts/tool-images-resume/after',
)
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'lti-'))
const dirs = Object.fromEntries(
  ['home', 'codex', 'tmp', 'work', 'device'].map((key) => [key, join(root, key)]),
)
for (const dir of Object.values(dirs)) mkdirSync(dir)
const imagePath = join(dirs.work, 'capture.png')
const image = new PNG({ width: 320, height: 200 })
for (let y = 0; y < image.height; y++)
  for (let x = 0; x < image.width; x++) {
    const at = (y * image.width + x) * 4
    image.data.set([x < 160 ? 35 : 240, y < 100 ? 180 : 80, 130, 255], at)
  }
const original = PNG.sync.write(image)
writeFileSync(imagePath, original)
let stage = 0
const model = await startResponsesModel(() =>
  stage++ === 0
    ? { call: { name: 'view_image', arguments: JSON.stringify({ path: imagePath }) } }
    : { text: '已读取测试图片。' },
)
writeFileSync(join(dirs.codex, 'config.toml'), codexConfig(model.baseUrl))
const reserve = createServer()
await new Promise((done) => reserve.listen(0, '127.0.0.1', done))
const port = reserve.address().port
await new Promise((done) => reserve.close(done))
const child = spawn(cli, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
  cwd: dirs.work,
  env: {
    HOME: dirs.home,
    CODEX_HOME: dirs.codex,
    TMPDIR: dirs.tmp,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (data) => {
  stderr += data
})
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const connect = async (handlers) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const opened = await new Promise((done) => {
      ws.once('open', () => done(true))
      ws.once('error', () => done(false))
    })
    if (!opened) {
      await pause(50)
      continue
    }
    ws.on('message', (data) => handlers.message(data.toString()))
    ws.on('close', () => handlers.close('native closed'))
    return {
      send: (raw) => ws.send(raw),
      close: () => {
        ws.removeAllListeners('message')
        ws.close()
      },
    }
  }
  throw new Error(`隔离 Codex 启动失败：${stderr}`)
}
const device = new DeviceServer({
  stateDir: dirs.device,
  upstreams: [{ id: 'codex', native: true, connect }],
  importExisting: false,
  wrapUp: false,
  wrapUpReminder: false,
})
device.titles.setEnabled('codex', false)
const server = await listenUnix(join(root, 'relay.sock'), (wire) => device.attach(wire))
const clients = []
const open = async (remote) => {
  const client = remote
    ? await TestClient.overSocket(join(root, 'relay.sock'))
    : new TestClient(device)
  clients.push(client)
  await client.initialize(['harness', 'toolImages', 'mediaImages'])
  return client
}
try {
  const client = await open(false)
  const { thread } = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':danger-full-access',
  })
  await client.call('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: '请读取测试图片。', text_elements: [] }],
  })
  await client.waitFor((frame) => frame.method === 'turn/completed', 60000)
  const live = client.notifications.find(
    (frame) => frame.method === 'item/completed' && frame.params?.item?.type === 'imageView',
  )
  assert.ok(live, '必须收到真实 Codex 的 imageView')
  const refs = live.params.item.litchToolImages
  assert.equal(refs?.length, 1, '实时工具结果必须有资产引用')
  // 实时捕获后改变源文件，历史必须仍绑定首次图片，不能重新读到新内容。
  image.data.fill(230)
  writeFileSync(imagePath, PNG.sync.write(image))
  client.close()
  const results = []
  for (const remote of [false, true]) {
    const reopened = await open(remote)
    const page = await reopened.call('thread/turns/list', {
      threadId: thread.id,
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    const resumed = await reopened.call('thread/resume', {
      threadId: thread.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
    })
    const find = (page) =>
      page.data.flatMap((turn) => turn.items).find((item) => item.id === live.params.item.id)
    const listed = find(page)
    const initial = find(resumed.initialTurnsPage)
    assert.deepEqual(listed?.litchToolImages, refs, '独立分页必须匹配实时图片')
    assert.ok(initial, '首屏必须包含同一条目')
    if (missing) assert.equal(initial.litchToolImages, undefined)
    else assert.deepEqual(initial.litchToolImages, refs, '恢复首屏必须匹配实时图片')
    const read = await reopened.call('litch/media/readImage', {
      source: `litch-tool-image:${refs[0].id}`,
    })
    assert.equal(read.dataBase64, original.toString('base64'), '历史资产必须仍是最初图片')
    const mode = remote ? 'relay' : 'direct'
    writeFileSync(
      join(output, `${mode}.json`),
      JSON.stringify({ live, page, resumed, read }, null, 2),
    )
    results.push({
      mode,
      live: refs[0].id,
      listed: listed.litchToolImages[0].id,
      initial: initial.litchToolImages?.[0]?.id ?? null,
    })
    reopened.close()
  }
  writeFileSync(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        codex: spawnSync(cli, ['--version'], {
          encoding: 'utf8',
          env: { HOME: dirs.home, CODEX_HOME: dirs.codex, PATH: dirname(process.execPath) },
        }).stdout.trim(),
        expectedMissing: missing,
        results,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(results, null, 2))
  if (process.argv.includes('--screenshot')) {
    const { captureToolImagesResume } = await import('./capture-tool-images-resume.mjs')
    await captureToolImagesResume(device, thread.id, dirs.home, output)
  }
} finally {
  for (const client of clients) client.close()
  await server.close()
  await device.close()
  const stopped = new Promise((done) => child.once('exit', done))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await stopped
  clearTimeout(timer)
  await model.close()
  rmSync(root, { recursive: true, force: true })
}
