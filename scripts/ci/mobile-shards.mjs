// 根据历史首轮耗时贪心均衡；每片八条。新 flow 自动加入，绝不因名单过时漏测。
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const weights = {
  mock: [105, 25, 60, 29, 54, 59, 95, 131, 111, 65, 51, 40, 47, 32, 50, 29, 39, 20],
  fixture: [66, 19, 69, 65, 81, 174],
}
export function mobileShards(flowsDir, count = 3) {
  const flows = ['mock', 'fixture'].flatMap((group) =>
    readdirSync(join(flowsDir, group))
      .filter((name) => name.endsWith('.yaml'))
      .sort()
      .map((name) => ({
        file: join(flowsDir, group, name),
        seconds: weights[group][Number(name.slice(0, 2)) - 1] ?? 60,
      })),
  )
  const capacity = Math.ceil(flows.length / count)
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }))
  for (const flow of flows.sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))) {
    const shard = shards
      .filter((one) => one.files.length < capacity)
      .sort((a, b) => a.seconds - b.seconds)[0]
    shard.files.push(flow.file)
    shard.seconds += flow.seconds
  }
  for (const shard of shards) shard.files.sort()
  return shards
}
