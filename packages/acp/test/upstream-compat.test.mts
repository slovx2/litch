// 与上游协议的兼容性：ACP 的入口，agent 是 test/fake-agent.mts。
// 用例在 packages/shared/test/compat-suite.mts，这里只管起入口。
//
// 回放夹具（protocol/compat/desktop-replay.json 的 expectations）和基线清单（protocol/compat/baseline.json）
// 里还没有 acp 这一项（那两个文件归注册线改）：没有时只跑结构校验的流程，出入记在诊断里，回放和基线跳过；
// 两边都收了 acp 之后自动跑完整的一套。

import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { baselinePath } from '../../shared/test/compat-baseline.mjs'
import type { EntryScene, SceneName, TurnScript } from '../../shared/test/compat-scene.mjs'
import { type OpenedEntry, upstreamCompatSuite } from '../../shared/test/compat-suite.mjs'
import { replayFixturePath } from '../../shared/test/desktop-replay.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import { runStandardFlow } from '../../shared/test/standard-flow.mjs'
import { findingKey } from '../../shared/test/strict-schema.mjs'
import { AcpServer } from '../src/server.mjs'
import { isolate } from './client.mjs'

// 假 agent 按用户说的头一个词演（见 fake-agent.mts）
const PROMPT: Record<SceneName, string | null> = {
  plain: 'hello',
  approval: 'run',
  // ACP 稳定版里没有向用户提问的请求
  question: null,
  slow: 'wait',
}

async function open(): Promise<OpenedEntry> {
  const isolated = await isolate()
  const server = new AcpServer(isolated.home, isolated.env)
  const client: StandardClient = new StandardClient((message) =>
    server.handle(peer, message as any),
  )
  const peer: RpcPeer = { id: 'standard', close() {}, send: (message) => client.accept(message) }
  const scene: EntryScene = {
    entry: 'acp',
    cwd: isolated.cwd,
    threadStart: {},
    approvalMethod: 'item/commandExecution/requestApproval',
    script: (name: SceneName): TurnScript | null => {
      const prompt = PROMPT[name]
      return prompt ? { prompt, streams: name === 'slow' } : null
    },
  }
  return {
    client,
    scene,
    async close() {
      await server.close()
      await isolated.restore()
    },
  }
}

const fixture = JSON.parse(readFileSync(replayFixturePath, 'utf8'))
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
if (fixture.expectations?.acp && baseline.entries?.acp)
  upstreamCompatSuite({ entry: 'acp', title: ' ACP 的入口', open })
else {
  test('结构校验：不声明扩展的客户端在 ACP 的入口上走常用流程', async (t) => {
    const opened = await open()
    try {
      await runStandardFlow(opened.client, opened.scene)
    } finally {
      await opened.close()
    }
    if (opened.client.mistakes.length)
      throw new Error(`测试自己发错了：\n${opened.client.mistakes.join('\n')}`)
    const keys = [...new Set([...opened.client.findings.values()].map(findingKey))].sort()
    t.diagnostic(`与上游结构的出入 ${keys.length} 处（基线清单还没有 acp 这一项）`)
    for (const key of keys) t.diagnostic(`  ${key}`)
  })
  test('回放与基线：等 protocol/compat 收了 acp 这一项', { skip: true }, () => {})
}
