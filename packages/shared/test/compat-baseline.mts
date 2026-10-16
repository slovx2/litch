// 基线清单：现有实现与上游结构的出入先记在 protocol/compat/baseline.json 里，测试只认清单里的。
// 清单只许变短：新出现的出入要么修掉、要么（确实是有意的）连同原因加进清单并说明；
// 清单里已经不再出现的条目会让测试失败，提醒把它删掉。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { protocolDirectory } from '../src/protocol-path.mjs'
import { type Finding, findingKey } from './strict-schema.mjs'

export const baselinePath = resolve(
  process.env.CODEX_SCHEMA_DIR ?? protocolDirectory(),
  '../../../compat/baseline.json',
)

interface BaselineGroup {
  /** 差什么，和校验报出来的写法一字不差。同一个原因下有好几样时写成数组：每一样在 where 的每一处都出现 */
  problem: string | string[]
  /** 为什么先留着 */
  reason: string
  /** 出现在哪些消息的哪个位置，每项是“消息类别 方法 位置” */
  where: string[]
}

/** 这个入口的基线：出入的键（和 findingKey 同一种写法）→ 原因 */
export function baselineOf(entry: string): Map<string, string> {
  const file = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    entries: Record<string, BaselineGroup[]>
  }
  const known = new Map<string, string>()
  for (const group of file.entries[entry] ?? []) {
    if (!group.reason?.trim()) throw new Error(`基线清单里 ${entry} 有一组没写原因`)
    for (const problem of [group.problem].flat())
      for (const where of group.where) {
        const key = `${where} ${problem}`
        if (known.has(key)) throw new Error(`基线清单里 ${entry} 的这一条写了两遍：${key}`)
        known.set(key, group.reason)
      }
  }
  return known
}

export interface BaselineVerdict {
  /** 清单里没有的出入 */
  unexpected: string[]
  /** 清单里有、这次没出现的 */
  stale: string[]
}

export function compareWithBaseline(entry: string, findings: Iterable<Finding>): BaselineVerdict {
  const known = baselineOf(entry)
  const actual = new Set([...findings].map(findingKey))
  return {
    unexpected: [...actual].filter((key) => !known.has(key)).sort(),
    stale: [...known.keys()].filter((key) => !actual.has(key)).sort(),
  }
}

/**
 * 实际的出入必须都在基线里。complete：这个入口的回放和流程都完整跑完了，
 * 这时清单里没再出现的条目也算失败；没跑完整时只查有没有新增的。
 */
export function assertBaseline(
  entry: string,
  findings: Iterable<Finding>,
  options: { complete: boolean; samples?: Map<string, unknown> },
): void {
  const all = [...findings]
  dump(entry, all)
  const verdict = compareWithBaseline(entry, all)
  const lines: string[] = []
  if (verdict.unexpected.length) {
    lines.push(
      `${entry}：没声明扩展的连接上出现了基线清单之外的出入（${verdict.unexpected.length} 处）。`,
      '是新加的扩展内容就按连接的声明来发；确实是有意的，连同原因加进 protocol/compat/baseline.json：',
    )
    for (const key of verdict.unexpected) {
      lines.push(`  + ${key}`)
      const sample = options.samples?.get(key)
      if (sample !== undefined) lines.push(`      例：${JSON.stringify(sample).slice(0, 240)}`)
    }
  }
  if (options.complete && verdict.stale.length) {
    lines.push(
      `${entry}：基线清单里有 ${verdict.stale.length} 处已经不再出现，把它们从 protocol/compat/baseline.json 里删掉（清单只许变短）：`,
    )
    for (const key of verdict.stale) lines.push(`  - ${key}`)
  }
  if (lines.length) throw new Error(lines.join('\n'))
}

// 维护用：设了 LITCH_COMPAT_DUMP（一个目录）时，把这个入口这次实际的出入按基线清单的写法存一份，
// 好拿去和清单对着看。它不改清单：清单里要不要留、原因怎么写，都得人来定。
function dump(entry: string, findings: Finding[]): void {
  const directory = process.env.LITCH_COMPAT_DUMP
  if (!directory) return
  const known = baselineOf(entry)
  const groups = new Map<string, BaselineGroup & { problem: string }>()
  for (const finding of findings) {
    const group = groups.get(finding.problem) ?? {
      problem: finding.problem,
      reason: known.get(findingKey(finding)) ?? '',
      where: [],
    }
    const where = `${finding.kind} ${finding.method} ${finding.path || '/'}`
    if (!group.where.includes(where)) group.where.push(where)
    groups.set(finding.problem, group)
  }
  const sorted = [...groups.values()].sort((a, b) => a.problem.localeCompare(b.problem))
  for (const group of sorted) group.where.sort()
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${entry}.json`), `${JSON.stringify(sorted, null, 2)}\n`)
}
