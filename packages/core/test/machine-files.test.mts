// litch_machine 的 read_file、write_file、list_dir 和访问范围：对着假机器（machine-kit.test.mts）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MACHINE_LIMITS } from '../../protocol/src/client-tools-machine.mjs'
import { createMachineExecutor } from '../src/device/machine/executor.mjs'
import { fakeClock } from './helpers.mjs'
import { FakeMachine, fakeContext, textOf } from './machine-kit.test.mjs'

function world(denied: string[] = []) {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop')
  const session = new FakeMachine('session', 'session', {
    system: 'Linux x86_64',
    home: '/home/song',
  })
  const executor = createMachineExecutor({ clock: time.clock })
  const ctx = fakeContext([desktop, session], { denied })
  return { desktop, session, executor, ...ctx }
}

test('read_file：小文件原样回，审批按 read 问；offset、length 切一段并说接着从哪读', async () => {
  const { desktop, executor, context, asks, logs } = world()
  desktop.fs.file('/Users/song/notes.txt', 'line one\nline two\n')
  const whole = await executor.call('read_file', { path: '~/notes.txt' }, context)
  assert.equal(textOf(whole), '/Users/song/notes.txt (18 bytes)\nline one\nline two\n')
  assert.equal(asks[0]?.class, 'read')
  assert.deepEqual(
    { action: asks[0]?.ask.action, path: asks[0]?.ask.path },
    { action: 'read', path: '/Users/song/notes.txt' },
  )
  const part = await executor.call(
    'read_file',
    { path: '/Users/song/notes.txt', offset: 5, length: 3 },
    context,
  )
  assert.equal(textOf(part), '/Users/song/notes.txt: bytes 5-8 of 18; continue with offset 8\none')
  assert.deepEqual(logs[0], {
    tool: 'read_file',
    summary: '/Users/song/notes.txt',
    result: 'ok',
    flagged: false,
  })
  // 小文件走 fs/readFile，不起读段的脚本
  assert.equal(desktop.scripts.readRange ?? 0, 0)
})

test('read_file：大文件只读那一段（脚本），切开的 UTF-8 字符不要；默认最多读 readBytes', async () => {
  const { desktop, executor, context } = world()
  const text = '汉'.repeat(500_000) // 150 万字节
  desktop.fs.file('/Users/song/big.txt', text)
  const first = textOf(await executor.call('read_file', { path: '~/big.txt' }, context))
  assert.equal(desktop.scripts.readRange, 1)
  const head = first.slice(0, first.indexOf('\n'))
  // 262144 不是 3 的倍数：末尾切开的那个字不要
  assert.equal(head, `/Users/song/big.txt: bytes 0-262143 of 1500000; continue with offset 262143`)
  assert.equal(first.slice(head.length + 1), '汉'.repeat(262143 / 3))
  const middle = textOf(
    await executor.call('read_file', { path: '~/big.txt', offset: 1, length: 10 }, context),
  )
  assert.equal(middle, '/Users/song/big.txt: bytes 3-9 of 1500000; continue with offset 9\n汉汉')
  const past = await executor.call('read_file', { path: '~/big.txt', offset: 2_000_000 }, context)
  assert.match(textOf(past), /\[litch:invalid\] offset 2000000 is past the end/)
  assert.ok(MACHINE_LIMITS.readBytes === 262144)
})

test('read_file：图片作为图片给，别的二进制只报大小类型；目录、不存在的照实说', async () => {
  const { desktop, executor, context } = world()
  desktop.fs.file('/Users/song/shot.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  desktop.fs.file('/Users/song/blob.dat', new Uint8Array([1, 2, 0, 3, 4]))
  desktop.fs.file('/Users/song/a.zip', 'PK')
  desktop.fs.mkdirp('/Users/song/src')
  const image = await executor.call('read_file', { path: '~/shot.png' }, context)
  assert.equal(image.contentItems[1]?.type, 'inputImage')
  assert.equal(
    (image.contentItems[1] as { imageUrl: string }).imageUrl,
    'data:image/png;base64,iVBORwABAg==',
  )
  assert.match(
    textOf(await executor.call('read_file', { path: '~/blob.dat' }, context)),
    /binary file \(application\/octet-stream\), 5 bytes.*use copy/,
  )
  assert.match(
    textOf(await executor.call('read_file', { path: '~/a.zip' }, context)),
    /binary file \(application\/zip\)/,
  )
  assert.match(
    textOf(await executor.call('read_file', { path: '~/src' }, context)),
    /\[litch:invalid\].*is a folder; use list_dir/,
  )
  assert.match(
    textOf(await executor.call('read_file', { path: '~/nope' }, context)),
    /\[litch:failed\].*does not exist/,
  )
  assert.match(
    textOf(await executor.call('read_file', { path: 'rel/x' }, context)),
    /\[litch:invalid\] path must be an absolute path/,
  )
})

test('write_file：create 建父目录、已有就失败；overwrite 覆盖；append 接在后面；审批按 mutate', async () => {
  const { desktop, executor, context, asks } = world()
  const created = await executor.call(
    'write_file',
    { path: '~/new/deep/a.txt', content: '你好' },
    context,
  )
  assert.equal(textOf(created), 'Wrote 6 bytes to /Users/song/new/deep/a.txt (created).')
  assert.equal(desktop.fs.text('/Users/song/new/deep/a.txt'), '你好')
  assert.equal(asks[0]?.class, 'mutate')
  assert.equal(asks[0]?.ask.action, 'write')
  const again = await executor.call(
    'write_file',
    { path: '~/new/deep/a.txt', content: 'x' },
    context,
  )
  assert.match(textOf(again), /\[litch:invalid\].*already exists; use mode overwrite or append/)
  await executor.call(
    'write_file',
    { path: '~/new/deep/a.txt', content: 'one\n', mode: 'overwrite' },
    context,
  )
  const appended = await executor.call(
    'write_file',
    { path: '~/new/deep/a.txt', content: 'two\n', mode: 'append' },
    context,
  )
  assert.match(textOf(appended), /appended to/)
  assert.equal(desktop.fs.text('/Users/song/new/deep/a.txt'), 'one\ntwo\n')
  assert.equal(desktop.scripts.append, 1)
  desktop.fs.mkdirp('/Users/song/dir')
  assert.match(
    textOf(
      await executor.call(
        'write_file',
        { path: '~/dir', content: 'x', mode: 'overwrite' },
        context,
      ),
    ),
    /is a folder/,
  )
  assert.match(
    textOf(
      await executor.call('write_file', { path: '~/x', content: 'x', mode: 'replace' }, context),
    ),
    /mode must be/,
  )
})

test('list_dir：名字、类型、大小、时间，按深度往下；链接写指向；禁止位置列出但不往下', async () => {
  const { desktop, executor, context, asks } = world(['~/.ssh'])
  desktop.fs.file('/Users/song/proj/a.txt', 'hello')
  desktop.fs.file('/Users/song/proj/src/main.ts', 'x')
  desktop.fs.file('/Users/song/proj/src/deep/more.ts', 'y')
  desktop.fs.link('/Users/song/proj/link', '/tmp/elsewhere')
  desktop.fs.file('/Users/song/.ssh/id_ed25519', 'secret')
  const one = textOf(await executor.call('list_dir', { path: '~/proj' }, context))
  assert.equal(asks[0]?.class, 'read')
  assert.equal(asks[0]?.ask.action, 'list')
  assert.match(one, /^\/Users\/song\/proj: 3 entries, depth 1/)
  assert.match(one, /file +5 +2023-11-14T22:13:20Z +a\.txt/)
  assert.match(one, /link +- +\S+ +link -> \/tmp\/elsewhere/)
  assert.match(one, /dir +- +\S+ +src\//)
  assert.doesNotMatch(one, /main\.ts/)
  const two = textOf(await executor.call('list_dir', { path: '~/proj', depth: 2 }, context))
  assert.match(two, /src\/main\.ts/)
  assert.match(two, /src\/deep\//)
  assert.doesNotMatch(two, /more\.ts/)
  const home = textOf(await executor.call('list_dir', { path: '~', depth: 3 }, context))
  assert.match(home, /\.ssh\/ +\[blocked: not listed\]/)
  assert.doesNotMatch(home, /id_ed25519/)
  assert.match(home, /proj\/src\/main\.ts/)
  assert.match(
    textOf(await executor.call('list_dir', { path: '~/proj/a.txt' }, context)),
    /is not a folder/,
  )
  assert.match(
    textOf(await executor.call('list_dir', { path: '~', depth: 4 }, context)),
    /depth must be an integer from 1 to 3/,
  )
})

test('禁止位置：直接回 blocked、不弹卡片，写明是哪条；经符号链接、换大小写也挡；不存在的路径按最近的祖先算', async () => {
  const { desktop, executor, context, asks, logs } = world(['~/.ssh', '~/.codex/auth.json'])
  desktop.fs.file('/Users/song/.ssh/id_ed25519', 'secret')
  desktop.fs.file('/Users/song/.codex/auth.json', '{}')
  desktop.fs.file('/Users/song/.codex/config.toml', 'model = "x"')
  desktop.fs.link('/Users/song/proj/keys', '/Users/song/.ssh')
  desktop.fs.link('/Users/song/innocent.txt', '/Users/song/.codex/auth.json')
  const cases: [string, Record<string, unknown>, string][] = [
    ['read_file', { path: '~/.ssh/id_ed25519' }, '~/.ssh'],
    ['read_file', { path: '~/proj/keys/id_ed25519' }, '~/.ssh'],
    ['read_file', { path: '~/innocent.txt' }, '~/.codex/auth.json'],
    ['read_file', { path: '~/.SSH/id_ed25519' }, '~/.ssh'],
    ['read_file', { path: '~/proj/../.ssh/id_ed25519' }, '~/.ssh'],
    ['write_file', { path: '~/.ssh/authorized_keys', content: 'ssh-ed25519 AAA' }, '~/.ssh'],
    ['write_file', { path: '~/proj/keys/new/deeper/x', content: 'x' }, '~/.ssh'],
    ['list_dir', { path: '~/proj/keys' }, '~/.ssh'],
  ]
  for (const [tool, args, rule] of cases) {
    const response = await executor.call(tool, args, context)
    assert.equal(response.success, false, `${tool} ${JSON.stringify(args)}`)
    const text = textOf(response)
    assert.match(text, /^\[litch:blocked\]/, text)
    assert.ok(text.includes(`"${rule}"`), text)
  }
  assert.equal(asks.length, 0)
  assert.ok(logs.every((one) => one.result === 'blocked'))
  assert.equal(desktop.fs.resolve('/Users/song/.ssh/authorized_keys').node, undefined)
  // 同一目录里没被禁止的照常
  const fine = await executor.call('read_file', { path: '~/.codex/config.toml' }, context)
  assert.equal(fine.success, true, textOf(fine))
})

test('访问范围只管桌面端：别的机器上的同名路径照常；全放开时什么都不挡', async () => {
  const { session, executor, context } = world(['~/.ssh'])
  session.fs.file('/home/song/.ssh/config', 'Host *')
  const remote = await executor.call(
    'read_file',
    { path: '~/.ssh/config', machine: 'session' },
    context,
  )
  assert.equal(remote.success, true, textOf(remote))
  const open = world([])
  open.desktop.fs.file('/Users/song/.ssh/config', 'Host *')
  const allowed = await open.executor.call('read_file', { path: '~/.ssh/config' }, open.context)
  assert.equal(allowed.success, true, textOf(allowed))
})
