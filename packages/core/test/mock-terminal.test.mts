// 模拟核心里的假终端（packages/core/src/mock/mock-terminals.mts、mock-shell.mts）：提示符、回显，
// 和验收要用的三条假命令（慢慢出字、刷屏、进全屏再退出）。经真的通道订阅，和界面走的是同一条路。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  createMockCore,
  type MockCoreOptions,
  textToBase64,
} from '../src/index.mjs'
import { fakeClock } from './helpers.mjs'
import { watchTerminal, watchTerminals } from './terminal-world.mjs'

const never = { aborted: false, addEventListener() {} }
const STEP = 10

/** 去掉颜色和光标移动，只看字 */
const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')

function setup(options: Partial<MockCoreOptions> = {}, deviceId = 'local') {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: STEP, ...options })
  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId, ...params }, never)
  const open = async (rows = 24, cols = 80): Promise<string> => {
    const result = (await command('terminal.open', { workspaceId: null, rows, cols })) as {
      terminalId: string
    }
    return result.terminalId
  }
  /** 敲一串键 */
  const type = (terminalId: string, text: string) =>
    command('terminal.write', { terminalId, data: textToBase64(text) })
  return { core, time, command, open, type, list: watchTerminals(core, deviceId), deviceId }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('假终端：开起来有欢迎语和提示符，敲的字有回显，命令有结果', async () => {
  const { core, time, open, type, list } = setup()
  const id = await open()
  assert.deepEqual(
    [list.get(id).state, list.get(id).durable, list.get(id).seq, list.get(id).shown],
    ['running', true, 1, true],
  )
  const view = watchTerminal(core, id)
  time.advance(8)
  const prompt = plain(view.text).split('\r\n').at(-1) ?? ''
  assert.match(plain(view.text), /^Litch 的假终端。输入 help 看有哪些命令。\r\n/)
  assert.match(prompt, /:~\$ $/)

  await type(id, 'echo 你')
  time.advance(8)
  assert.ok(plain(view.text).endsWith(`${prompt}echo 你`), '敲到哪回显到哪')
  // 退格：宽字符退两格
  await type(id, '\u007f')
  time.advance(8)
  assert.ok(view.text.endsWith('\b\b  \b\b'))
  await type(id, '好 world\r')
  time.advance(8)
  assert.ok(plain(view.text).endsWith(`\r\n好 world\r\n${prompt}`))

  await type(id, 'size\r')
  time.advance(8)
  assert.ok(plain(view.text).endsWith(`\r\n24 80\r\n${prompt}`))
  await type(id, 'nosuch\r')
  time.advance(8)
  assert.match(plain(view.text), /litch-sh: 找不到这个命令：nosuch/)
})

test('慢慢出字：一步一步出，不是最后一起出；中断键马上停', async () => {
  const { core, time, open, type } = setup()
  const id = await open()
  const view = watchTerminal(core, id)
  await type(id, 'slow\r')
  const steps = () => plain(view.text).match(/第 \d+ 步，共 12 步/g)?.length ?? 0
  time.advance(STEP * 2)
  assert.equal(steps(), 1)
  time.advance(STEP * 2 * 4)
  assert.equal(steps(), 5)
  await type(id, '\u0003')
  time.advance(STEP * 2 * 20)
  assert.equal(steps(), 5, '中断之后不再出')
  assert.match(plain(view.text), /\^C\r\n[^\r\n]*\$ $/)

  // 不打断就走完，最后有一句结束语
  await type(id, 'slow\r')
  time.advance(STEP * 2 * 12)
  assert.equal(steps(), 17)
  assert.match(plain(view.text), /做完了。\r\n[^\r\n]*\$ $/)
})

test('刷屏：给了行数就刷那么多行，结尾是固定的一句；不给就刷到按中断键', async () => {
  const { core, time, open, type } = setup()
  const id = await open()
  const view = watchTerminal(core, id)
  time.advance(8)
  const before = view.received
  await type(id, 'flood 300\r')
  for (let at = 0; at < 20; at++) time.advance(8)
  const text = plain(view.text)
  assert.match(text, /flood 完成：300 行\r\n[^\r\n]*\$ $/)
  assert.equal(text.match(/^\d{9} \| the quick brown fox/gm)?.length, 300)
  assert.match(text, /000000300 \| /)
  assert.ok(view.received - before > 300 * 96)

  await type(id, 'flood\r')
  for (let at = 0; at < 10; at++) time.advance(8)
  const flowing = view.received
  for (let at = 0; at < 10; at++) time.advance(8)
  assert.ok(view.received > flowing + 100_000, '还在刷')
  await type(id, '\u0003')
  // 中断之前已经出来、还压在缓冲里的那些照样要过一遍界面：等它走完
  let stopped = -1
  for (let round = 0; round < 400 && stopped !== view.received; round++) {
    stopped = view.received
    for (let at = 0; at < 4; at++) time.advance(8)
  }
  for (let at = 0; at < 10; at++) time.advance(8)
  assert.equal(view.received, stopped, '中断之后停了')
  assert.match(plain(view.text).slice(-200), /\^C\r\n[^\r\n]*\$ $/)
  // 压着的最多是缓冲那一段加界面手上的，不随刷了多久涨
  assert.ok(stopped - flowing < 2 * 1024 * 1024, `中断之后又过了 ${stopped - flowing} 字节`)
})

test('全屏程序：进备用屏幕，窗口变了会重画，按 q 回到原来的屏幕', async () => {
  const { core, time, command, open, type } = setup()
  const id = await open()
  const view = watchTerminal(core, id)
  await type(id, 'fullscreen\r')
  time.advance(8)
  assert.ok(view.text.includes('\u001b[?1049h\u001b[?25l'))
  assert.match(plain(view.text), /全屏程序（假的）[\s\S]*24 x 80[\s\S]*按 q 退出/)
  // 它自己在动
  time.advance(STEP * 4 * 3)
  assert.match(plain(view.text), /已经刷新 3 次/)
  // 别的键不当命令
  await type(id, 'ls\r')
  time.advance(8)
  assert.equal(view.text.includes('\u001b[?1049l'), false)

  await command('terminal.resize', { terminalId: id, rows: 40, cols: 120 })
  time.advance(8)
  assert.match(plain(view.text), /40 x 120/)

  await type(id, 'q')
  time.advance(8)
  assert.match(view.text, /\u001b\[\?25h\u001b\[\?1049l[^\r\n]*\$ $/)
  time.advance(STEP * 4 * 5)
  assert.equal(
    plain(view.text)
      .match(/已经刷新 \d+ 次/g)
      ?.at(-1),
    '已经刷新 3 次',
    '退出之后不再刷',
  )
})

test('退出、重开、改名、两种关法；到了上限说得出来', async () => {
  const { core, time, command, open, type, list } = setup()
  const id = await open()
  const view = watchTerminal(core, id)
  await command('terminal.rename', { terminalId: id, title: '  构建  ' })
  assert.equal(list.get(id).title, '构建')

  await type(id, 'exit 3\r')
  assert.deepEqual([list.get(id).state, list.get(id).exitCode], ['exited', 3])
  assert.equal((await failureOf(type(id, 'x'))).text?.key, 'terminal.notRunning')
  await command('terminal.restart', { terminalId: id, rows: 24, cols: 80 })
  time.advance(8)
  assert.match(plain(view.text), /^Litch 的假终端。/)
  assert.deepEqual([list.get(id).state, view.state.resets, view.state.epoch], ['running', 1, 1])

  // 留在设备上：不在标签里了，还列得出来、接得回
  await command('terminal.close', { terminalId: id, mode: 'leave' })
  assert.deepEqual([list.get(id).shown, list.get(id).state], [false, 'running'])
  await command('terminal.show', { terminalId: id })
  assert.equal(list.get(id).shown, true)
  await command('terminal.close', { terminalId: id, mode: 'end' })
  assert.equal(list.state.terminals.size, 0)

  for (let at = 0; at < 8; at++) await open()
  const failure = await failureOf(open())
  assert.deepEqual(failure.text, { key: 'terminal.limit', args: { limit: 8 } })
  assert.deepEqual(
    list.shown().map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6, 7, 8],
  )
})

test('只有一个 harness 入口的设备：终端随连接结束，留不住；英文的示例说英文', async () => {
  const { core, time, command, open, type, list } = setup({ lang: 'en' }, 'nas')
  assert.equal(list.state.durable, false)
  const id = await open()
  assert.equal(list.get(id).durable, false)
  assert.equal(
    (await failureOf(command('terminal.close', { terminalId: id, mode: 'leave' }))).code,
    'rejected',
  )
  const view = watchTerminal(core, id, { deviceId: 'nas' })
  await type(id, 'slow\r')
  time.advance(STEP * 2)
  assert.match(plain(view.text), /^A pretend terminal from Litch\./)
  assert.match(plain(view.text), /step 1 of 12: printing slowly/)
})
