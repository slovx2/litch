// 与上游协议的兼容性：Claude Code 的入口。
// 用例在 packages/shared/test/compat-suite.mts，这里只管起入口：适配器是一个真的子进程（标准输入输出上逐行的 JSON），
// 后面是 CHA_CLAUDE_CLI 指定的隔离 CLI，模型是回环上的 Mock LLM，主目录是临时的。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { EntryScene, SceneName, TurnScript } from '../../shared/test/compat-scene.mjs'
import { type OpenedEntry, upstreamCompatSuite } from '../../shared/test/compat-suite.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import { requireClaudeCliFor } from './fixtures/claude-cli.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { protocolEnv } from './fixtures/protocol-client.mjs'
import { reclaimAtEnd } from './fixtures/reclaim.mjs'

const text = (value: string) => [{ type: 'text', text: value }]

async function open(): Promise<OpenedEntry> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'upstream-compat-')))
  await requireClaudeCliFor(home)
  const cwd = join(home, 'project')
  await mkdir(cwd)
  await mkdir(join(home, 'claude'), { recursive: true })
  const model = new MockLLM()
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/adapter.mjs', import.meta.url)), 'app-server'],
    { env: protocolEnv(home, await model.start(), false) },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  const exited = once(child, 'close')
  const client = new StandardClient((message) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
  })
  createInterface({ input: child.stdout }).on('line', (line) => client.accept(JSON.parse(line)))

  let closing: Promise<void> | undefined
  const shutdown = async (): Promise<void> => {
    reclaimed()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    // 收尾有时限：适配器不理会 SIGTERM 就强制结束，并让用例失败
    let forced = false
    const escalate = setTimeout(() => {
      forced = true
      child.kill('SIGKILL')
    }, 15_000)
    await exited
    clearTimeout(escalate)
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (forced) throw new Error(`适配器 15 秒内没有响应 SIGTERM，已强制结束：${stderr}`)
  }
  const close = (): Promise<void> => {
    closing ??= shutdown()
    return closing
  }
  const reclaimed = reclaimAtEnd(close)

  const scene: EntryScene = {
    entry: 'claude',
    cwd,
    // 完全访问加“要求时询问”：改文件的工具调用会来问
    threadStart: { sandbox: 'danger-full-access', approvalPolicy: 'on-request' },
    approvalMethod: 'item/fileChange/requestApproval',
    script(name: SceneName): TurnScript {
      if (name === 'approval') {
        model.enqueue(() => [
          {
            type: 'tool_use',
            id: `toolu_write_${model.requests.length}`,
            name: 'Write',
            input: { file_path: join(cwd, `approved-${model.requests.length}.txt`), content: 'ok' },
          },
        ])
        model.enqueue(() => text('文件写好了。'))
        return { prompt: '写一个文件。' }
      }
      if (name === 'question') {
        model.enqueue(() => [
          {
            type: 'tool_use',
            id: `toolu_ask_${model.requests.length}`,
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: '走哪条路线？',
                  header: '路线',
                  multiSelect: false,
                  options: [
                    { label: '甲', description: '第一条' },
                    { label: '乙', description: '第二条' },
                  ],
                },
              ],
            },
          },
        ])
        model.enqueue(() => text('收到回答。'))
        return { prompt: '先问我一个问题。' }
      }
      if (name === 'slow') {
        // 模型说了头一段就停住：等回合被打断之后才放手
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        model.enqueue(() => ({ disconnectAfterText: '慢慢说，', afterDelta: () => held }))
        return { prompt: '慢慢说。', streams: true, release }
      }
      model.enqueue(() => text('好的。'))
      return { prompt: '说一句话。' }
    },
    planMode: {
      model: 'claude-sonnet-4-6',
      // 模型把计划说出来，紧接着交计划（ExitPlanMode）；入口不问，回合到此结束
      plan() {
        model.enqueue(() => [
          ...text('# 计划\n\n1. 写一个文件'),
          {
            type: 'tool_use',
            id: `toolu_exit_${model.requests.length}`,
            name: 'ExitPlanMode',
            input: {},
          },
        ])
      },
      implement() {
        model.enqueue(() => text('照计划做完了。'))
      },
    },
  }
  return { client, scene, close }
}

upstreamCompatSuite({ entry: 'claude', title: ' Claude Code 的入口', open, timeoutMs: 300_000 })
