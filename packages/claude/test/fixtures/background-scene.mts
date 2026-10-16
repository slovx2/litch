import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCliCommand } from './claude-cli.mjs'
import { MockLLM, type ModelRequest, type ModelStep } from './mock-llm.mjs'
import { descendants, killAll, type ProcessRow, processTable } from './process-tree.mjs'
import { ProtocolClient } from './protocol-client.mjs'

export interface Scene {
  home: string
  workspace: string
  model: MockLLM
  client: ProtocolClient
  threadId: string
}

// 一个适配器、一个回环模型、一个完全访问的线程：后台命令不经审批直接执行。
export async function startScene(
  name: string,
  extraEnv: Record<string, string> = {},
): Promise<Scene> {
  const home = await mkdtemp(join(tmpdir(), `${name}-`))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', extraEnv)
  const { thread } = await client.request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  return { home, workspace, model, client, threadId: thread.id }
}

export async function disposeScene(scene: Scene): Promise<void> {
  const tree = adapterTree(scene).map((row) => row.pid)
  await scene.client.close()
  await scene.model.close()
  killAll(tree)
  await rm(scene.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

// 每个用例用不同的时长，按命令行就能在进程表里认出自己起的那条命令。
export const uniqueSleep = (seconds: number): string =>
  `sleep ${seconds}.${String(process.hrtime.bigint()).slice(-6)}`

export const backgroundBash =
  (id: string, command: string): ModelStep =>
  () => [
    {
      type: 'tool_use',
      id,
      name: 'Bash',
      input: { command, run_in_background: true, description: 'background command' },
    },
  ]

export const say =
  (text: string): ModelStep =>
  () => [{ type: 'text', text }]

export function adapterTree(scene: Scene): ProcessRow[] {
  return descendants(scene.client.process.pid as number)
}

// 适配器名下的 CLI 进程。守护进程的命令行里也带着 CLI 的路径，按开头区分。
export function cliProcesses(scene: Scene): ProcessRow[] {
  const cli = claudeCliCommand()
  return adapterTree(scene).filter((row) => row.command.startsWith(cli))
}

export function commandAlive(command: string): boolean {
  return processTable().some(
    (row) => row.command.includes(command) && !row.command.includes('/bin/ps'),
  )
}

export async function listTerminals(scene: Scene): Promise<Array<Record<string, unknown>>> {
  const listed = await scene.client.request('thread/backgroundTerminals/list', {
    threadId: scene.threadId,
  })
  return listed.data
}

export async function runTurn(scene: Scene, text: string): Promise<any> {
  const { turn } = await scene.client.request('turn/start', {
    threadId: scene.threadId,
    input: [{ type: 'text', text }],
  })
  return scene.client.completed(turn.id)
}

export async function readTurns(scene: Scene): Promise<any[]> {
  const read = await scene.client.request('thread/read', {
    threadId: scene.threadId,
    includeTurns: true,
  })
  return read.thread.turns
}

export async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时：${what}`)
}

// 模型请求里最后一条用户消息的全部文字。
export function lastUserText(request: ModelRequest): string {
  const message = [...request.messages].reverse().find((entry: any) => entry.role === 'user')
  const content = message?.content
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : [])
    .map((block: any) =>
      block.type === 'text'
        ? block.text
        : block.type === 'tool_result'
          ? JSON.stringify(block.content)
          : '',
    )
    .join('\n')
}
