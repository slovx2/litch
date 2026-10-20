import assert from 'node:assert/strict'
import { test } from 'node:test'
import { systemSecrets } from '../chromium-crypto.mjs'
import { readMacKeychain } from '../mac-keychain.mjs'
import { runCommand } from '../process.mjs'
import { faultStatus, ReadFault } from '../result.mjs'

test('子进程仅通过 stdin/stdout 交换数据；完成后退出', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    Buffer.from('fixture input'),
    new AbortController().signal,
  )
  assert.equal(result.code, 0)
  assert.equal(result.stdout.toString(), 'fixture input')
  assert.equal(result.stderr.length, 0)
})

test('子进程取消会结束子进程，spawn 失败不会抛出原始系统错误', async () => {
  const controller = new AbortController()
  const pending = runCommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    Buffer.alloc(0),
    controller.signal,
  )
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error instanceof ReadFault && error.status === 'cancelled',
  )
  await assert.rejects(
    runCommand(
      '/nonexistent/litch-test-command',
      [],
      Buffer.alloc(0),
      new AbortController().signal,
    ),
    (error) => error instanceof ReadFault && error.status === 'failed',
  )
})

test('钥匙串以应用自身运行；环境隔离、原始字节保留、输出缓冲擦除', async () => {
  const stdout = Buffer.from(' fixture\0key \n')
  const stderr = Buffer.from('private error')
  const result = await readMacKeychain('edge', new AbortController().signal, {
    executable: '/Applications/Litch.app/Contents/MacOS/Litch',
    directory: '/fixture/native',
    run: async (file, args, input, _signal, options) => {
      assert.equal(file, '/Applications/Litch.app/Contents/MacOS/Litch')
      assert.equal(args.length, 1)
      assert.ok(args[0]?.endsWith('keychain-helper.mjs'))
      assert.equal(input.toString(), 'edge')
      assert.equal(options?.env?.ELECTRON_RUN_AS_NODE, '1')
      assert.ok(
        Object.keys(options?.env ?? {}).every((key) =>
          [
            'ELECTRON_RUN_AS_NODE',
            'HOME',
            'USER',
            'LOGNAME',
            'TMPDIR',
            'LANG',
            'LC_ALL',
            '__CF_USER_TEXT_ENCODING',
          ].includes(key),
        ),
      )
      return { code: 0, stdout, stderr }
    },
  })
  assert.equal(result.toString(), ' fixture\0key \n')
  assert.ok(stdout.every((byte) => byte === 0))
  assert.ok(stderr.every((byte) => byte === 0))
})

test('钥匙串拒绝、不支持、失败只返回固定状态', async () => {
  for (const [code, status] of [
    [2, 'denied'],
    [3, 'unsupported'],
    [1, 'failed'],
    [0, 'failed'],
  ] as const) {
    await assert.rejects(
      readMacKeychain('chrome', new AbortController().signal, {
        executable: 'fixture',
        directory: 'fixture',
        run: async () => ({ code, stdout: Buffer.alloc(0), stderr: Buffer.from('private') }),
      }),
      (error) => error instanceof ReadFault && error.status === status,
    )
  }
})

test('Windows DPAPI 请求不出现在命令参数里，输出缓冲用后擦除', async () => {
  const stdout = Buffer.from(Buffer.from('fixture password').toString('base64'))
  const api = systemSecrets(async (_file, args, input) => {
    assert.ok(args.includes('-NoProfile'))
    assert.ok(args.includes('-NonInteractive'))
    assert.equal(input.toString(), Buffer.from('fixture encrypted bytes').toString('base64'))
    assert.ok(!args.join(' ').includes(input.toString()))
    return { code: 0, stdout, stderr: Buffer.alloc(0) }
  })
  assert.equal(
    (
      await api.unprotect(Buffer.from('fixture encrypted bytes'), new AbortController().signal)
    ).toString(),
    'fixture password',
  )
  assert.ok(stdout.every((byte) => byte === 0))
})

test('错误只分类已知状态，不返回外部错误文本', () => {
  assert.equal(faultStatus({ code: 'EBUSY', message: 'secret' }), 'locked')
  assert.equal(faultStatus({ code: 'EACCES', message: 'secret' }), 'denied')
  assert.equal(faultStatus({ code: 'ENOENT' }), 'missing')
  assert.equal(faultStatus(new Error('secret')), 'failed')
})
