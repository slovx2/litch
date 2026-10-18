// 一个入口的协议兼容性测试：三条用例，各入口的 upstream-compat.test.mts 只管“怎么起这个入口”。
// 1. 回放：官方桌面端会发的请求序列（desktop-replay.mts）。
// 2. 结构校验：不声明任何扩展的客户端走一遍常用流程（standard-flow.mts）。
// 3. 两遍里服务端发来的每条消息与上游结构的出入，只认基线清单里记着的；清单里不再出现的要删（compat-baseline.mts）。
import test from 'node:test'
import { assertBaseline } from './compat-baseline.mjs'
import type { EntryScene } from './compat-scene.mjs'
import { runDesktopReplay } from './desktop-replay.mjs'
import type { StandardClient } from './standard-client.mjs'
import { runStandardFlow } from './standard-flow.mjs'
import type { Finding } from './strict-schema.mjs'

export interface OpenedEntry {
  /** 已经接到这个入口上、还没握手的客户端 */
  client: StandardClient
  scene: EntryScene
  /** 收掉服务、假模型和临时目录 */
  close(): Promise<void>
}

export interface CompatSuite {
  /** 基线清单里这个入口的名字 */
  entry: string
  /** 用例名字里怎么称呼它 */
  title: string
  /** 每遍各起一份全新的入口：隔离的临时目录、回环上的假模型 */
  open(): Promise<OpenedEntry>
  timeoutMs?: number
}

export function upstreamCompatSuite(suite: CompatSuite): void {
  const findings: Finding[] = []
  const samples = new Map<string, unknown>()
  const finished = new Set<string>()
  const timeout = suite.timeoutMs ?? 180_000

  const run = async (
    work: (client: StandardClient, scene: EntryScene) => Promise<unknown>,
  ): Promise<void> => {
    const opened = await suite.open()
    try {
      await work(opened.client, opened.scene)
    } finally {
      for (const [key, finding] of opened.client.findings) {
        findings.push(finding)
        if (!samples.has(key)) samples.set(key, opened.client.samples.get(key))
      }
      await opened.close()
    }
    if (opened.client.mistakes.length)
      throw new Error(`测试自己发错了：\n${opened.client.mistakes.join('\n')}`)
  }

  test(`回放：官方桌面端的请求序列对着${suite.title}`, { timeout }, async () => {
    await run(runDesktopReplay)
    finished.add('replay')
  })

  test(`结构校验：不声明扩展的客户端在${suite.title}上走常用流程`, { timeout }, async () => {
    await run(runStandardFlow)
    finished.add('flow')
  })

  test(`基线：${suite.title.trim()}与上游结构的出入都在清单里，清单里没有多余的`, () => {
    assertBaseline(suite.entry, findings, { complete: finished.size === 2, samples })
  })
}
