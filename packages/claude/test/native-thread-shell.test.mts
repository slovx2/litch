import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('SHELL-001：未知会话及无效命令不能启动真实 shell，合法命令保留协议规定的完全访问', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-thread-shell-'))
  const model = new MockLLM()
  const endpoint = await model.start()
  const client = await ProtocolClient.start(home, endpoint)
  try {
    const cwd = join(home, 'project')
    await mkdir(cwd)
    const { thread } = await client.request('thread/start', { cwd, sandbox: 'read-only' })
    const marker = join(home, 'unexpected.txt')
    const command = `printf 'UNEXPECTED' > '${marker}'`
    for (const threadId of ['', 'does-not-exist', null, 5])
      await client.raw('thread/shellCommand', { threadId, command }, -32602)
    for (const invalid of ['', '   ', null, 5, [], 'printf bad\0'])
      await client.raw('thread/shellCommand', { threadId: thread.id, command: invalid }, -32602)
    await assert.rejects(access(marker))
    // 固定协议明确要求手动 shell 命令完全访问，不能误继承会话只读沙箱。
    await client.request('thread/shellCommand', {
      threadId: thread.id,
      command:
        "printf 'ACTUAL' | tr '[:upper:]' '[:lower:]' > shell-result.txt; printf 'SHELL_DONE_7294'",
    })
    await client.notification('command/exec/outputDelta', (params) =>
      Buffer.from(params.deltaBase64, 'base64').toString().includes('SHELL_DONE_7294'),
    )
    assert.equal(await readFile(join(cwd, 'shell-result.txt'), 'utf8'), 'actual')
    await client.request('thread/delete', { threadId: thread.id })
    await client.raw('thread/shellCommand', { threadId: thread.id, command }, -32602)
    await assert.rejects(access(marker))
    assert.equal(model.requests.length, 0, '手动 shell 不能请求模型')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
