import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cappedWriter, startAndroidDiagnostics, trackerDecoder } from './android-diagnostics.mjs'

const frame = (text) => `${Buffer.byteLength(text).toString(16).padStart(4, '0')}${text}`
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, '诊断事件未按预期到达')
    await pause(10)
  }
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'litch-adb-diagnostics-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('ADB 状态帧支持拆包、粘包、空快照；不把半个设备状态当掉线', () => {
  const snapshots = []
  const decode = trackerDecoder((value) => snapshots.push(value))
  const first = 'emulator-5554\tdevice product:测试\n'
  const bytes = Buffer.from(`OKAY${frame(first)}${frame('')}${frame('emulator-5554\toffline\n')}`)
  for (const byte of bytes) decode(Buffer.from([byte]))
  assert.deepEqual(snapshots, [first, '', 'emulator-5554\toffline\n'])
  assert.throws(() => trackerDecoder(() => {})(Buffer.from('FAIL')), /拒绝/)
  assert.throws(() => trackerDecoder(() => {})(Buffer.from('OKAYnope')), /长度损坏/)
})

test('日志限额保留最早证据并只报告一次截断', (t) => {
  const file = join(temporary(t), 'log')
  let limits = 0
  const write = cappedWriter(file, 5, () => limits++)
  write('abc')
  write('def')
  write('later')
  assert.equal(readFileSync(file, 'utf8'), 'abcde')
  assert.equal(limits, 1)
})

test('掉线后只重接日志观察流；保留首段、记录阶段、收掉自己启动的进程', async (t) => {
  const directory = temporary(t)
  const adb = join(directory, 'adb')
  const commands = join(directory, 'commands.jsonl')
  const release = join(directory, 'end-first-stream')
  writeFileSync(
    adb,
    `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(commands)}, JSON.stringify({pid:process.pid,args})+'\\n')
if (args[4] === 'shell') { console.log('boot-id\\n440\\n1\\nrunning\\nadb'); process.exit(0) }
console.log('本段首证据')
setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0) }, 10)
`,
  )
  chmodSync(adb, 0o755)
  let peer
  const server = createServer((socket) => {
    peer = socket
    socket.once('data', (request) => {
      assert.equal(request.toString(), frame('host:track-devices-l'))
      socket.write(`OKAY${frame('emulator-5554\tdevice\n')}`)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => {
    peer?.destroy()
    server.close()
  })
  const observer = startAndroidDiagnostics({
    adbBin: adb,
    serial: 'emulator-5554',
    directory,
    port: server.address().port,
  })
  t.after(() => observer.stop())
  const events = () =>
    readFileSync(join(directory, 'android-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
  await observer.ready
  await until(() => events().some((event) => event.kind === 'guest-identity'))
  observer.mark('flow-start', { flow: 'fixture/01-home.yaml', attempt: 1 })
  peer.write(frame('emulator-5554\toffline\n'))
  await until(() => events().some((event) => event.state === 'offline'))
  writeFileSync(release, '')
  await until(() =>
    events().some((event) => event.kind === 'observer-close' && event.command === 'logcat'),
  )
  rmSync(release)
  peer.write(frame('emulator-5554\tdevice\n'))
  await until(() => events().some((event) => event.kind === 'logcat-start' && event.segment === 2))
  await until(
    () =>
      readFileSync(commands, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse)
        .filter((row) => row.args[4] === 'logcat').length === 2,
  )
  observer.mark('flow-end', { status: 1 })
  await observer.stop()
  assert.match(readFileSync(join(directory, 'android-logcat-1.txt'), 'utf8'), /本段首证据/)
  const rows = readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(rows.every((row) => ['shell', 'logcat'].includes(row.args[4])))
  for (const row of rows) assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' })
  assert.equal(events().find((event) => event.kind === 'flow-end').status, 1)
  assert.ok(events().some((event) => event.kind === 'diagnostics-stop'))
})

test('宿主 ADB 不可用时诊断报告错误并可收尾，不启动新 server', async (t) => {
  const directory = temporary(t)
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  const observer = startAndroidDiagnostics({
    adbBin: '/missing-adb',
    serial: 'emulator-5554',
    directory,
    port,
  })
  await observer.ready
  await observer.stop()
  assert.match(readFileSync(join(directory, 'android-events.jsonl'), 'utf8'), /tracker-error/)
})
