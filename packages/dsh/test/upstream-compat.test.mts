// 与上游协议的兼容性：dsh 的入口。用例在 packages/shared/test/compat-suite.mts，这里只管起入口。
// 要本机装着 dsh（CHA_DSH_CLI 或 PATH），模型是回环上的假模型，状态目录是临时的（client.mts 的 isolate）。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RpcPeer } from '../../shared/src/types.mjs'
import type { EntryScene, SceneName, TurnScript } from '../../shared/test/compat-scene.mjs'
import { type OpenedEntry, upstreamCompatSuite } from '../../shared/test/compat-suite.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import { DshServer } from '../src/server.mjs'
import { isolate } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 三种回合用户说的话。假模型按这句话作答，不按请求到达的先后：
// 回合一开始就被打断时，那一回合的模型请求来不来得及发出去不一定，按先后排的应答会错位到下一回合。
const PROMPT = {
  plain: '说一句话。',
  approval: '跑一条要提权的命令。',
  question: '问我一个问题。',
  slow: '慢慢说。',
}

const respond = scripted({
  [PROMPT.plain]: [[{ type: 'text', chunks: ['好的。'] }]],
  // dsh 只在命令要求提权时才问
  [PROMPT.approval]: [
    [
      {
        type: 'tool_use',
        name: 'bash',
        input: {
          command: 'echo compat',
          description: '需要提权的命令',
          sandbox_permissions: 'danger-full-access',
          justification: '兼容性测试的审批。',
        },
      },
    ],
    [{ type: 'text', chunks: ['命令跑完了。'] }],
  ],
  // 模型调 dsh 的提问工具，dsh 转来问用户
  [PROMPT.question]: [
    [
      {
        type: 'tool_use',
        name: 'ask_user_question',
        input: {
          questions: [
            { id: 'pick', question: '选哪个？', header: '选择', options: [{ label: '甲' }] },
            { id: 'name', question: '叫什么？' },
          ],
        },
      },
    ],
    [{ type: 'text', chunks: ['知道了。'] }],
  ],
  [PROMPT.slow]: [
    [{ type: 'text', chunks: Array.from({ length: 80 }, (_, i) => `慢${i} `), delayMs: 100 }],
  ],
})

async function open(): Promise<OpenedEntry> {
  // 不带工具的模型请求是 dsh 自己在起标题，固定回一句
  const isolated = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['回放的标题'] }],
  )
  // 工作目录里摆一项技能：回放里 skills/list 的应答带着一条，条目的形状也校验得到
  await mkdir(join(isolated.cwd, '.dsh/skills/replay'), { recursive: true })
  await writeFile(
    join(isolated.cwd, '.dsh/skills/replay/SKILL.md'),
    '---\nname: replay\ndescription: 回放用的技能\n---\n\n正文\n',
  )
  const server = new DshServer(join(isolated.root, 'home'))
  const client: StandardClient = new StandardClient((message) =>
    server.handle(peer, message as any),
  )
  const peer: RpcPeer = { id: 'standard', close() {}, send: (message) => client.accept(message) }
  const scene: EntryScene = {
    entry: 'dsh',
    cwd: isolated.cwd,
    threadStart: { permissions: ':workspace' },
    approvalMethod: 'item/commandExecution/requestApproval',
    // slow 不等话流出来：回合一开始就打断
    script: (name: SceneName): TurnScript => ({ prompt: PROMPT[name] }),
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

upstreamCompatSuite({ entry: 'dsh', title: ' dsh 的入口', open })
