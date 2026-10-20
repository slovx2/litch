import assert from 'node:assert/strict'
import { test } from 'node:test'
import { systemSecrets } from '../chromium-crypto.mjs'
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

test('钥匙串命令、服务名和系统拒绝映射；密钥空白不被 trim', async () => {
  const api = systemSecrets(async (file, args, input) => {
    assert.equal(file, '/usr/bin/security')
    assert.deepEqual(args, ['find-generic-password', '-s', 'Microsoft Edge Safe Storage', '-w'])
    assert.equal(input.length, 0)
    return { code: 0, stdout: Buffer.from(' fixture key \n'), stderr: Buffer.alloc(0) }
  })
  assert.equal(
    (await api.keychain('edge', new AbortController().signal)).toString(),
    ' fixture key ',
  )
  for (const [code, message] of [
    [128, 'User canceled'],
    [36, 'User interaction is not allowed.'],
    [51, 'Authorization denied'],
  ] as const) {
    const denied = systemSecrets(async () => ({
      code,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(message),
    }))
    await assert.rejects(
      denied.keychain('chrome', new AbortController().signal),
      (error) => error instanceof ReadFault && error.status === 'denied',
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
