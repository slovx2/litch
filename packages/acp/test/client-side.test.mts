import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readTextFile, Terminals, writeTextFile } from '../src/client-side.mjs'

// agent 反过来请我们做的：读写文件、终端。

test('读文件按行取，没有的文件答 -32002；写文件建好上级目录，带回原来的内容', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-acp-fs-')))
  try {
    const path = join(root, 'a.txt')
    await writeFile(path, '一\n二\n三\n')
    assert.equal((await readTextFile({ path })).content, '一\n二\n三\n')
    assert.equal((await readTextFile({ path, line: 2, limit: 1 })).content, '二')
    assert.equal((await readTextFile({ path, line: 2 })).content, '二\n三\n')
    await assert.rejects(readTextFile({ path: join(root, 'none') }), (e: any) => e.code === -32002)
    await assert.rejects(readTextFile({ path: 'relative.txt' }), (e: any) => e.code === -32602)
    const nested = join(root, 'x', 'y', 'b.txt')
    assert.deepEqual(await writeTextFile({ path: nested, content: '新' }), {
      path: nested,
      before: null,
      after: '新',
    })
    assert.equal((await writeTextFile({ path: nested, content: '再' })).before, '新')
    assert.equal(await readFile(nested, 'utf8'), '再')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('终端：输出按块转出去，超了上限从开头丢；一整行命令交给 sh；kill 结束整组', async () => {
  const chunks: string[] = []
  const terminals = new Terminals((_session, _id, delta) => chunks.push(delta))
  const { terminalId } = terminals.create({
    sessionId: 's',
    command: 'printf',
    args: ['0123456789'],
    outputByteLimit: 4,
  })
  assert.deepEqual(await terminals.waitForExit({ terminalId }), { exitCode: 0, signal: null })
  assert.deepEqual(terminals.output({ terminalId }), {
    output: '6789',
    truncated: true,
    exitStatus: { exitCode: 0, signal: null },
  })
  assert.equal(chunks.join(''), '0123456789')
  await terminals.release({ terminalId })
  assert.throws(
    () => terminals.output({ terminalId }),
    (e: any) => e.code === -32602,
  )

  const shell = terminals.create({ sessionId: 's', command: 'echo a && exit 3' })
  assert.deepEqual(await terminals.waitForExit(shell), { exitCode: 3, signal: null })
  assert.equal(terminals.output(shell).output, 'a\n')

  // 命令里的 LITCH_THREAD_ID 是这个会话的号，agent 给的同名变量不算数
  const named = terminals.create({
    sessionId: 'thread-7',
    command: 'printf "[%s]" "$LITCH_THREAD_ID"',
    env: [{ name: 'LITCH_THREAD_ID', value: 'other' }],
  })
  await terminals.waitForExit(named)
  assert.equal(terminals.output(named).output, '[thread-7]')

  const long = terminals.create({ sessionId: 's', command: 'sleep 30' })
  const started = Date.now()
  await terminals.kill(long)
  const exit = await terminals.waitForExit(long)
  assert.ok(exit.signal === 'SIGTERM' || exit.exitCode !== 0)
  assert.ok(Date.now() - started < 3000)
  await terminals.closeAll()
})
