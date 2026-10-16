import assert from 'node:assert/strict'
import fs, {
  appendFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { watchNativeSession } from '../src/native-watch.mjs'
import { SessionManager } from '../src/sdk.mjs'

// 执行期间盯着原生会话文件的定时器（native-watch.mts）：别的实例写了同一个会话就停下。
// 用的是用户装的那份 Pi 的 SessionManager（写文件的就是它），会话对象只给定时器用到的两样。
// 定时器换成模拟的，一次 tick 正好核对一次，和机器快慢无关；量的是读了多少字节、解析了多少行。

interface Scene {
  manager: SessionManager
  path: string
  dir: string
  cwd: string
  /** 让定时器核对一次 */
  tick(): void
  /** 到现在为止报了几次冲突 */
  conflicts(): number
}

async function scene(run: (scene: Scene) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-watch-'))
  const cwd = join(root, 'project')
  const dir = join(root, 'sessions')
  await mkdir(cwd)
  const manager = SessionManager.create(cwd, dir)
  // 有了一条对话 Pi 才建文件（头一行是会话头，之后一个条目一行）
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '开始' }],
    timestamp: Date.now(),
  } as any)
  const path = manager.getSessionFile() as string
  const session = {
    get sessionFile() {
      return manager.getSessionFile()
    },
    sessionManager: manager,
  } as unknown as AgentSession
  mock.timers.enable({ apis: ['setInterval'] })
  let conflicts = 0
  const stop = watchNativeSession(session, () => conflicts++)
  try {
    await run({
      manager,
      path,
      dir,
      cwd,
      tick: () => mock.timers.tick(25),
      conflicts: () => conflicts,
    })
  } finally {
    stop()
    mock.timers.reset()
    await rm(root, { recursive: true, force: true })
  }
}

/** 跑一段代码，数它读了多少字节的文件、调了几次 JSON.parse（定时器一行解析一次） */
function count(run: () => void): { bytes: number; lines: number } {
  const original = { readFileSync: fs.readFileSync, readSync: fs.readSync, parse: JSON.parse }
  let bytes = 0
  let lines = 0
  fs.readFileSync = ((...args: any[]) => {
    const out = (original.readFileSync as any)(...args)
    bytes += typeof out === 'string' ? Buffer.byteLength(out) : out.length
    return out
  }) as typeof fs.readFileSync
  fs.readSync = ((...args: any[]) => {
    const read = (original.readSync as any)(...args)
    bytes += read
    return read
  }) as typeof fs.readSync
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    lines++
    return original.parse(...args)
  }) as typeof JSON.parse
  // 被测的模块是按名字导入的 fs 函数，换了 fs 上的属性要同步一次才看得到
  syncBuiltinESMExports()
  try {
    run()
  } finally {
    fs.readFileSync = original.readFileSync
    fs.readSync = original.readSync
    JSON.parse = original.parse
    syncBuiltinESMExports()
  }
  return { bytes, lines }
}

const lastLine = (path: string) => readFileSync(path, 'utf8').trimEnd().split('\n').at(-1) ?? ''

test('WATCH-PI-001：会话越写越长，每次核对读的字节、解析的行数只和新增的部分有关', async () => {
  await scene(({ manager, path, tick, conflicts }) => {
    tick() // 头一次核对是整份读一遍，不算在里面
    const calls = 200
    const payload = '结果'.repeat(4000)
    const early = { bytes: 0, lines: 0, appended: 0 }
    const late = { bytes: 0, lines: 0, appended: 0 }
    for (let index = 0; index < calls; index++) {
      const before = statSync(path).size
      manager.appendCustomEntry('watch-test', { index, payload })
      const appended = statSync(path).size - before
      const half = index < calls / 2 ? early : late
      const used = count(tick)
      half.bytes += used.bytes
      half.lines += used.lines
      half.appended += appended
    }
    assert.equal(conflicts(), 0, '自己写的不算别人改的')
    for (const half of [early, late]) assert.equal(half.lines, calls / 2, '每次只解析新增的那一行')
    assert.ok(
      late.bytes <= early.bytes * 1.05,
      `后一半的核对读了 ${late.bytes} 字节，前一半 ${early.bytes}：读的量随会话变长涨了`,
    )
    const appended = early.appended + late.appended
    const read = early.bytes + late.bytes
    assert.ok(read < appended * 2, `一共追加 ${appended} 字节，核对时读了 ${read} 字节`)
  })
})

test('WATCH-PI-002：外来的追加都认得出：另一个实例写的条目、照抄的一行、写到一半的一行', async () => {
  const cases: Array<[string, (scene: Scene) => void]> = [
    [
      '另一个 Pi 实例追加了条目',
      ({ path, dir, cwd }) => SessionManager.open(path, dir, cwd).appendSessionInfo('外部并发修改'),
    ],
    ['照抄我们最后一行再追加一遍', ({ path }) => appendFileSync(path, `${lastLine(path)}\n`)],
    ['写到一半、还没换行', ({ path }) => appendFileSync(path, '{"type":"custom","id":"half')],
    [
      '我们刚追加了一条，紧跟着又来一条外来的',
      ({ manager, path }) => {
        manager.appendCustomEntry('watch-test', { mine: true })
        appendFileSync(path, `${lastLine(path)}\n`)
      },
    ],
  ]
  for (const [name, act] of cases)
    await scene((s) => {
      s.tick()
      s.manager.appendCustomEntry('watch-test', { before: true })
      s.tick()
      assert.equal(s.conflicts(), 0, `${name}：之前不该报`)
      act(s)
      s.tick()
      assert.equal(s.conflicts(), 1, `${name}：没认出来`)
    })
})

test('WATCH-PI-003：文件被截短、原地改写、换掉、删掉都认得出；换成内容一样的文件不算', async () => {
  const cases: Array<[string, (scene: Scene) => void, number]> = [
    [
      '截掉最后一行',
      ({ path }) => truncateSync(path, statSync(path).size - lastLine(path).length - 1),
      1,
    ],
    [
      '原地改写，长度不变，最后一行的内容变了',
      ({ path }) =>
        writeFileSync(path, readFileSync(path, 'utf8').replace('"before":true', '"before":null')),
      1,
    ],
    [
      '换成另一个会话的文件',
      ({ path, dir, cwd }) => {
        const other = SessionManager.create(cwd, join(dir, 'other'))
        other.appendMessage({ role: 'user', content: '别处', timestamp: Date.now() } as any)
        renameSync(other.getSessionFile() as string, path)
      },
      1,
    ],
    ['删掉', ({ path }) => rmSync(path), 1],
    [
      '换成内容一样的新文件',
      ({ path, dir }) => {
        const copy = join(dir, 'copy.jsonl')
        writeFileSync(copy, readFileSync(path))
        renameSync(copy, path)
      },
      0,
    ],
  ]
  for (const [name, act, expected] of cases)
    await scene((s) => {
      s.tick()
      s.manager.appendCustomEntry('watch-test', { before: true })
      s.tick()
      const inode = statSync(s.path).ino
      act(s)
      s.tick()
      assert.equal(s.conflicts(), expected, name)
      if (expected) return
      // 认下了新文件之后，自己接着写照常不报
      assert.notEqual(statSync(s.path).ino, inode, `${name}：没有换成新文件`)
      s.manager.appendCustomEntry('watch-test', { after: true })
      s.tick()
      assert.equal(s.conflicts(), 0, `${name}：之后自己写的不该报`)
    })
})
