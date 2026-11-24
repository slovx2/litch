import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activateScript, frontmostPid, macForegroundKeeper } from '../src/foreground.mjs'

/** 假的 lsappinfo/osascript：按前台 PID 序列回答，记录激活调用。 */
function fakeSystem(fronts: number[]) {
  const activated: string[] = []
  let index = 0
  const exec = async (file: string, args: string[]) => {
    if (file === '/usr/bin/osascript') {
      activated.push(args[args.length - 1] ?? '')
      return 'true\n'
    }
    if (args[0] === 'front') return `ASN:0x0-0x${(100 + index).toString(16)}:\n`
    return `"pid"=${fronts[Math.min(index++, fronts.length - 1)]}\n`
  }
  return { exec, activated }
}

test('读出前台应用 PID，格式不对时返回 null', async () => {
  assert.equal(await frontmostPid(fakeSystem([42]).exec), 42)
  assert.equal(await frontmostPid(async () => 'garbage'), null)
})

test('前台被抢后还给输入前的应用', async () => {
  const system = fakeSystem([11, 22])
  const keeper = macForegroundKeeper({ exec: system.exec })
  keeper.note()
  assert.equal(await keeper.restore(), true)
  assert.deepEqual(system.activated, [activateScript(11)])
  assert.match(system.activated[0], /runningApplicationWithProcessIdentifier\(11\)/)
})

test('输入前前台就是 Chrome、没有记录或记录过期时不动', async () => {
  {
    const system = fakeSystem([22, 22])
    const keeper = macForegroundKeeper({ exec: system.exec })
    keeper.note()
    assert.equal(await keeper.restore(), false)
    assert.deepEqual(system.activated, [])
  }
  {
    const system = fakeSystem([11, 22])
    assert.equal(await macForegroundKeeper({ exec: system.exec }).restore(), false)
  }
  {
    let now = 0
    const system = fakeSystem([11, 22])
    const keeper = macForegroundKeeper({ exec: system.exec, now: () => now })
    keeper.note()
    now += 60_000
    assert.equal(await keeper.restore(), false)
    assert.deepEqual(system.activated, [])
  }
})

test('激活脚本只接受正整数 PID', () => {
  assert.throws(() => activateScript(0))
  assert.throws(() => activateScript(Number.NaN))
})
