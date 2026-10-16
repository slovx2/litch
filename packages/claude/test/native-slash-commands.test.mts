import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 斜杠命令在真实 CLI 上认不认得：客户端发来的命令前后常带空白（输入框里回车、粘贴进来的换行）。
// 实测（host-cli 里的 CLI）：进程里头一条消息前面带空白 CLI 也认；之后的消息前面带空白就不认了（后面带空白认），
// 入口再把它当成普通话、带上目标提醒发成内容块，更不认。不认的时候命令原样当成一句话交给模型。
// 用自定义命令看它展开没有。放在用户这一级（CLAUDE_CONFIG_DIR 下的 commands），不放在项目里（.claude/commands）：
// 实测项目在 /tmp（macOS 上的 /private/tmp，也是 Linux 上默认的临时目录）下面时，CLI 不加载项目里的命令，
// 只说“没有这个命令”；在 macOS 默认的 /var/folders 下面才加载。

const BODY = 'EXPANDED-HELLO-BODY'

test('NATIVE-SLASH-001：会话第二个回合发前后带空白的斜杠命令，有没有目标提醒要带，CLI 都展开', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-slash-'))
  // 夹具把 CLAUDE_CONFIG_DIR 设成 home 下面的 claude
  await mkdir(join(home, 'claude', 'commands'), { recursive: true })
  await writeFile(join(home, 'claude', 'commands', 'hello.md'), `${BODY}\n`)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    for (const [text, goal] of [
      ['\n/hello', false],
      ['  /hello\n', false],
      ['\n/hello', true],
      ['  /hello\n', true],
    ] as const) {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      })
      model.enqueue(() => [{ type: 'text', text: 'first' }])
      const first = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '先说一句' }],
      })
      assert.equal((await client.completed(first.turn.id)).status, 'completed')
      // 目标变了：下一条消息要带提醒
      if (goal)
        await client.request('thread/goal/set', {
          threadId: thread.id,
          objective: '一个目标',
          status: 'paused',
        })
      let seen = ''
      model.enqueue((request) => {
        seen = JSON.stringify(request.messages.at(-1))
        return [{ type: 'text', text: 'ok' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.ok(
        seen.includes(BODY),
        `${JSON.stringify(text)}（目标提醒：${goal}）应展开成命令的内容：${seen}`,
      )
    }
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
