import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// fixtures/mcp-count-server.mjs 的配置和它记下的东西。服务每被起一次是一份，按进程号认。

/** 一份服务的来龙去脉 */
export interface CountedServer {
  pid: number
  /** 握手时报的客户端名字：适配器自己连的是 codex-harness-adapter，Claude Code 连的是 claude-code */
  client: string | null
  /** 被调用过的工具，按先后 */
  called: string[]
  closed: boolean
}

/** 起这个服务的 stdio 配置。Claude Code 的配置文件和会话配置里都能用 */
export function countServer(log: string, tools: string[] = ['echo']) {
  return {
    command: process.execPath,
    args: [resolve('packages/claude/test/fixtures/mcp-count-server.mjs')],
    env: { FIXTURE_LOG_PATH: log, FIXTURE_TOOLS: JSON.stringify(tools) },
  }
}

/** 到现在为止起过的每一份，按起的先后 */
export async function countedServers(log: string): Promise<CountedServer[]> {
  const entries = (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
  return entries
    .filter((entry) => entry.event === 'started')
    .map(({ pid }) => {
      const own = entries.filter((entry) => entry.pid === pid)
      return {
        pid,
        client: own.find((entry) => entry.event === 'connected')?.client ?? null,
        called: own.filter((entry) => entry.event === 'called').map((entry) => entry.tool),
        closed: own.some((entry) => entry.event === 'closed'),
      }
    })
}
