// 等待真实 HID 空闲后逐组运行；真人输入令本组作废，不能算作产品失败或通过。
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { hidIdleSeconds } from './idle.mjs'

const deadline = Math.min(
  Date.now() + 2 * 60 * 60 * 1000,
  process.env.LITCH_CU_DEADLINE ? Date.parse(process.env.LITCH_CU_DEADLINE) : Infinity,
)
if (!Number.isFinite(deadline)) throw new Error('截止时间无效')
const groups = process.argv.slice(2)
if (!groups.length) groups.push('routing', 'collision', 'electron')
if (groups.some((group) => !['routing', 'collision', 'electron', 'coexist'].includes(group)))
  throw new Error('未知验收组')
const completed = []
let discarded = 0
for (const group of groups) {
  while (true) {
    if (Date.now() + 30_000 >= deadline) {
      console.log(
        JSON.stringify({
          status: 'notVerified',
          completed,
          remaining: groups.filter((g) => !completed.includes(g)),
          discarded,
        }),
      )
      process.exit(2)
    }
    const idle = hidIdleSeconds()
    if (idle < 60) {
      console.log(
        JSON.stringify({
          status: 'waiting',
          group,
          idle,
          deadline: new Date(deadline).toISOString(),
        }),
      )
      await delay(Math.min(120_000, deadline - Date.now()))
      continue
    }
    console.log(JSON.stringify({ status: 'starting', group, idle }))
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))], {
      env: { ...process.env, LITCH_CU_GROUP: group },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (part) => {
      output += part
    })
    child.stderr.on('data', (part) => {
      output += part
    })
    const code = await new Promise((resolve, reject) => {
      child.on('exit', resolve)
      child.on('error', reject)
    })
    console.log(JSON.stringify({ group, code, output }))
    if (code === 75) {
      discarded++
      await delay(Math.min(120_000, Math.max(0, deadline - Date.now())))
      continue
    }
    if (code !== 0) process.exit(1)
    completed.push(group)
    break
  }
}
console.log(JSON.stringify({ status: 'complete', completed, discarded }))
