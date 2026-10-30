// node scripts/cu-trial/summarize.mjs <第一轮记录目录> [第二轮记录目录 ...]
// 只读实测 JSONL，输出 Markdown 对比表；工具耗时与包含模型推理的回合墙钟分列。
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const read = (directory, name) => {
  const path = join(directory, name)
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
}
const sum = (rows) => rows.reduce((total, row) => total + row.durationMs, 0)
console.log('|轮次/任务|调用数|失败数|工具耗时 ms|回合墙钟 ms|')
console.log('|---|---:|---:|---:|---:|')
const details = []
for (const directory of process.argv.slice(2)) {
  const calls = read(directory, 'calls.jsonl'),
    turns = read(directory, 'turns.jsonl')
  const name = basename(directory)
  for (const task of new Set([...calls, ...turns].map((row) => row.task))) {
    const group = calls.filter((row) => row.task === task)
    console.log(
      `|${name}/${task}|${group.length}|${group.filter((row) => !row.result.success).length}|${sum(group)}|${sum(turns.filter((row) => row.task === task))}|`,
    )
  }
  console.log(
    `|${name}/总计|${calls.length}|${calls.filter((row) => !row.result.success).length}|${sum(calls)}|${sum(turns)}|`,
  )
  for (const [index, call] of calls.entries()) {
    if (!call.result.success)
      details.push(
        `${name} #${index + 1} ${call.tool} (${call.durationMs} ms): ${call.result.contentItems
          .filter((item) => item.type === 'inputText')
          .map((item) => item.text)
          .join(' ')}`,
      )
  }
  for (const { message } of read(directory, 'events.jsonl')) {
    if (message?.method === 'item/completed' && message.params.item.type === 'agentMessage') {
      details.push(`${name} 模型回报：${message.params.item.text}`)
    }
  }
}
console.log(
  '\n回合完成只表示模型结束回答，不代表任务成功。文件核验见 verification.jsonl；完整结果和图片见 calls.jsonl、events.jsonl。',
)
for (const detail of details) console.log(`\n${detail}`)
