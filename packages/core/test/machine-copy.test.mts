// litch_machine 的 copy：会话所在的那台和桌面端之间两个方向、大文件分块、目录、访问范围。对着假机器。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COPY_CHUNK } from '../src/device/machine/copy.mjs'
import { createMachineExecutor } from '../src/device/machine/executor.mjs'
import { fakeClock } from './helpers.mjs'
import { FakeMachine, fakeContext, textOf } from './machine-kit.test.mjs'

function world(denied: string[] = []) {
  const time = fakeClock()
  const desktop = new FakeMachine('desktop', 'desktop', { name: 'Developer MacBook' })
  const session = new FakeMachine('session', 'session', {
    name: 'dev-box',
    system: 'Linux x86_64',
    home: '/home/dev',
  })
  const executor = createMachineExecutor({ clock: time.clock })
  const ctx = fakeContext([desktop, session], { denied })
  return { desktop, session, executor, ...ctx }
}

const from = (machine: string, path: string) => ({ machine, path })

test('copy：允许写目标根时仍拦住其中的禁止子目录', async () => {
  const { desktop, session, executor, context } = world(['~/target/pkg/private'])
  session.fs.file('/home/dev/pkg/private/key', 'should not copy')
  session.fs.file('/home/dev/pkg/ok', 'allowed')
  desktop.fs.mkdirp('/Users/dev/target')
  const response = await executor.call(
    'copy',
    {
      from: from('session', '~/pkg'),
      to: from('desktop', '~/target'),
    },
    context,
  )
  assert.equal(response.success, true, textOf(response))
  assert.match(textOf(response), /blocked locations/)
  assert.equal(desktop.fs.resolve('/Users/dev/target/pkg/private').node, undefined)
  assert.equal(desktop.fs.text('/Users/dev/target/pkg/ok'), 'allowed')
})

test('copy：会话那台到桌面端的一个文件，审批按 mutate，卡片写两头的机器名', async () => {
  const { desktop, session, executor, context, asks, logs } = world()
  session.fs.file('/home/dev/out/app.tar', 'build output')
  const response = await executor.call(
    'copy',
    { from: from('session', '~/out/app.tar'), to: from('desktop', '~/Downloads/app.tar') },
    context,
  )
  assert.equal(response.success, true, textOf(response))
  assert.equal(
    textOf(response),
    'Copied 1 file (12 bytes) from session:/home/dev/out/app.tar to desktop:/Users/dev/Downloads/app.tar.',
  )
  assert.equal(desktop.fs.text('/Users/dev/Downloads/app.tar'), 'build output')
  assert.equal(asks[0]?.class, 'mutate')
  assert.deepEqual(asks[0]?.ask.copy, {
    from: { machine: 'dev-box', path: '/home/dev/out/app.tar' },
    to: { machine: 'Developer MacBook', path: '/Users/dev/Downloads/app.tar' },
  })
  assert.equal(
    logs[0]?.summary,
    'session:/home/dev/out/app.tar -> desktop:/Users/dev/Downloads/app.tar',
  )
})

test('copy：大文件分块搬（读一段、写进同一个进程的标准输入），内容一字不差', async () => {
  const { desktop, session, executor, context } = world()
  const size = COPY_CHUNK * 2 + 12345
  const data = new Uint8Array(size)
  for (let at = 0; at < size; at++) data[at] = (at * 7 + 3) % 251
  session.fs.file('/home/dev/big.bin', data)
  const response = await executor.call(
    'copy',
    { from: from('session', '/home/dev/big.bin'), to: from('desktop', '~/big.bin') },
    context,
  )
  assert.equal(response.success, true, textOf(response))
  assert.match(textOf(response), new RegExp(`\\(${size} bytes\\)`))
  assert.deepEqual(desktop.fs.read('/Users/dev/big.bin'), data)
  assert.equal(session.scripts.readRange, 3)
  assert.equal(desktop.scripts.write, 1)
})

test('copy：桌面端的目录到会话那台，审批按 read；禁止位置跳过、链接跳过，都写明', async () => {
  const { desktop, session, executor, context, asks } = world(['~/proj/.env.d'])
  desktop.fs.file('/Users/dev/proj/a.txt', 'A')
  desktop.fs.file('/Users/dev/proj/src/b.ts', 'B')
  desktop.fs.mkdirp('/Users/dev/proj/empty')
  desktop.fs.file('/Users/dev/proj/.env.d/token', 'secret')
  desktop.fs.link('/Users/dev/proj/link', '/etc/passwd')
  session.fs.mkdirp('/home/dev/work')
  const response = await executor.call(
    'copy',
    { from: from('desktop', '~/proj'), to: from('session', '~/work') },
    context,
  )
  assert.equal(response.success, true, textOf(response))
  assert.equal(asks[0]?.class, 'read')
  const text = textOf(response)
  // 目标是已有的目录：放进它里面
  assert.match(
    text,
    /^Copied 2 files in 3 folders \(2 bytes\) from desktop:\/Users\/dev\/proj to session:\/home\/dev\/work\/proj\./,
  )
  assert.match(text, /skipped 1 symbolic links: link/)
  assert.match(text, /skipped 1 blocked locations: \.env\.d/)
  assert.equal(session.fs.text('/home/dev/work/proj/a.txt'), 'A')
  assert.equal(session.fs.text('/home/dev/work/proj/src/b.ts'), 'B')
  assert.equal(session.fs.resolve('/home/dev/work/proj/empty').node?.type, 'd')
  assert.equal(session.fs.resolve('/home/dev/work/proj/.env.d').node, undefined)
  assert.equal(session.fs.resolve('/home/dev/work/proj/link').node, undefined)
})

test('copy：桌面端那头碰到禁止位置直接 blocked，不弹卡片；目标那边的链接不许穿过去', async () => {
  const { desktop, session, executor, context, asks } = world(['~/.ssh'])
  desktop.fs.file('/Users/dev/.ssh/id_ed25519', 'secret')
  session.fs.file('/home/dev/key', 'evil')
  const out = await executor.call(
    'copy',
    { from: from('desktop', '~/.ssh/id_ed25519'), to: from('session', '~/stolen') },
    context,
  )
  assert.match(textOf(out), /^\[litch:blocked\].*"~\/\.ssh"/)
  const into = await executor.call(
    'copy',
    { from: from('session', '~/key'), to: from('desktop', '~/.ssh/authorized_keys') },
    context,
  )
  assert.match(textOf(into), /^\[litch:blocked\]/)
  assert.equal(asks.length, 0)
  assert.equal(session.fs.resolve('/home/dev/stolen').node, undefined)

  // 目标目录里有一个指向禁止位置的链接：复制目录时经它写的那些跳过
  session.fs.file('/home/dev/pkg/keys/authorized_keys', 'evil')
  session.fs.file('/home/dev/pkg/readme', 'hi')
  desktop.fs.mkdirp('/Users/dev/pkg')
  desktop.fs.link('/Users/dev/pkg/keys', '/Users/dev/.ssh')
  const merged = await executor.call(
    'copy',
    { from: from('session', '~/pkg'), to: from('desktop', '/Users/dev/pkg/') },
    context,
  )
  // 以斜杠结尾：放进它里面
  assert.match(textOf(merged), /to desktop:\/Users\/dev\/pkg\/pkg/)
  const direct = await executor.call(
    'copy',
    { from: from('session', '~/pkg'), to: from('desktop', '/Users/dev/elsewhere') },
    context,
  )
  assert.equal(direct.success, true)
  desktop.fs.mkdirp('/Users/dev/target')
  desktop.fs.link('/Users/dev/target/pkg', '/Users/dev/.ssh')
  const through = await executor.call(
    'copy',
    { from: from('session', '~/pkg'), to: from('desktop', '~/target') },
    context,
  )
  assert.match(textOf(through), /^\[litch:blocked\]/)
  desktop.fs.mkdirp('/Users/dev/again/pkg')
  desktop.fs.link('/Users/dev/again/pkg/keys', '/Users/dev/.ssh')
  const nested = await executor.call(
    'copy',
    { from: from('session', '~/pkg'), to: from('desktop', '~/again') },
    context,
  )
  assert.match(
    textOf(nested),
    /skipped 1 files whose destination goes through a symbolic link on the desktop: keys\/authorized_keys/,
  )
  assert.equal(desktop.fs.text('/Users/dev/.ssh/id_ed25519'), 'secret')
  assert.equal(desktop.fs.resolve('/Users/dev/.ssh/authorized_keys').node, undefined)
  assert.equal(desktop.fs.text('/Users/dev/again/pkg/readme'), 'hi')
})

test('copy：参数、不存在、自己复制进自己、文件和目录对不上', async () => {
  const { desktop, executor, context } = world()
  desktop.fs.file('/Users/dev/d/f', 'x')
  desktop.fs.file('/Users/dev/file', 'x')
  const call = (args: unknown) => executor.call('copy', args, context).then(textOf)
  assert.match(
    await call({ from: { machine: 'desktop' }, to: from('desktop', '~/x') }),
    /\[litch:invalid\] from\.path must be/,
  )
  assert.match(
    await call({ from: from('nas', '~/x'), to: from('desktop', '~/x') }),
    /unknown or offline/,
  )
  assert.match(
    await call({ from: from('desktop', '~/missing'), to: from('desktop', '~/x') }),
    /\[litch:failed\].*does not exist/,
  )
  assert.match(
    await call({ from: from('desktop', '~/d'), to: from('desktop', '~/d/inner') }),
    /into itself/,
  )
  assert.match(
    await call({ from: from('desktop', '~/d'), to: from('desktop', '~/file') }),
    /is a file; cannot copy a folder/,
  )
  assert.match(
    await call({ from: from('desktop', '~/file'), to: from('desktop', '~/file') }),
    /same file/,
  )
})
