// 把 Node 采样剖析的结果（.cpuprofile，bench-delta.mjs --cpu-prof 写出来的）汇总成几张表：
// 时间花在谁的代码里、哪些函数自己最费、适配器自己的函数连同它调的一共占多少。
// 用法：node scripts/bench-delta-hot.mjs <.cpuprofile 文件或装着它的目录> [--top N]
// 占比的分母不含空等（idle）。引擎内建的和原生的函数（JSON.stringify、SQLite 的写入）多半没有自己的一行，
// 时间算在调它的那个函数身上；有自己的一行而没有文件位置的（垃圾回收、读写套接字）归在“引擎与原生”里。
// 一个函数连它调的一共多少看第三张表。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/bench-delta-hot.mjs <.cpuprofile 文件或目录> [--top N]')
  process.exit(1)
}
const topAt = process.argv.indexOf('--top')
const TOP = topAt < 0 ? 15 : Number(process.argv[topAt + 1])
const files = statSync(target).isDirectory()
  ? readdirSync(target)
      .filter((name) => name.endsWith('.cpuprofile'))
      .map((name) => join(target, name))
  : [target]
if (!files.length) {
  console.error(`${target} 里没有 .cpuprofile 文件`)
  process.exit(1)
}

/** 一个函数算谁的：按它所在的文件分。依赖里的按最里面那一层包算，harness 带进来的别家的库算第三方库 */
function owner(url) {
  if (url.includes('/packages/pi/dist/pi/src/')) return 'Pi 入口（packages/pi）'
  if (url.includes('/packages/claude/dist/claude/src/')) return 'Claude 入口（packages/claude）'
  if (/\/packages\/[a-z]+\/dist\/shared\//.test(url)) return '共用层（packages/shared）'
  if (/\/packages\/[a-z]+\/dist\//.test(url)) return '适配器的别的包'
  const inner = url.lastIndexOf('/node_modules/')
  if (inner >= 0) {
    const name = url.slice(inner + '/node_modules/'.length)
    if (name.startsWith('@earendil-works/')) return 'Pi 本体（@earendil-works）'
    if (name.startsWith('@anthropic-ai/')) return 'Claude 的 SDK（@anthropic-ai）'
    return '第三方库'
  }
  if (url.startsWith('node:')) return 'Node 内建'
  return '引擎与原生'
}
const short = (url) =>
  url.replace(/^file:\/\//, '').replace(/^.*\/(packages|node_modules)\//, '$1/')
const ms = (us) => (us / 1000).toFixed(1).padStart(10)

for (const file of files) {
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  /** 每个节点自己身上的时间（微秒）：样本落在它上面的那些间隔加起来 */
  const self = new Map()
  profile.samples.forEach((id, index) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0))
  })
  const key = (node) =>
    `${node.callFrame.functionName || '(匿名)'}  ${short(node.callFrame.url)}${node.callFrame.url ? `:${node.callFrame.lineNumber + 1}` : ''}`
  const idle = (node) => node.callFrame.functionName === '(idle)'
  let busy = 0
  const byOwner = new Map()
  const bySelf = new Map()
  for (const node of profile.nodes) {
    const time = self.get(node.id) ?? 0
    if (idle(node) || !time) continue
    busy += time
    const who = owner(node.callFrame.url)
    byOwner.set(who, (byOwner.get(who) ?? 0) + time)
    bySelf.set(key(node), (bySelf.get(key(node)) ?? 0) + time)
  }
  /** 每个函数连它调的一共多少：同一个函数在一条调用链上出现几次只算最外面那次 */
  const byTotal = new Map()
  const walk = (node, open) => {
    let total = self.get(node.id) ?? 0
    const name = key(node)
    const outermost = !open.has(name)
    if (outermost) open.add(name)
    for (const child of node.children ?? []) total += walk(nodes.get(child), open)
    if (outermost) {
      open.delete(name)
      if (!idle(node)) byTotal.set(name, (byTotal.get(name) ?? 0) + total)
    }
    return total
  }
  walk(profile.nodes[0], new Set())

  const share = (time) => `${((time / busy) * 100).toFixed(1).padStart(5)}%`
  const table = (title, rows) => {
    console.log(`\n${title}`)
    for (const [name, time] of rows) console.log(`${ms(time)} ms ${share(time)}  ${name}`)
  }
  const sorted = (map) => [...map].sort((a, b) => b[1] - a[1])
  console.log(`\n${file}\n不算空等一共 ${(busy / 1000).toFixed(1)} ms`)
  table('时间花在谁的代码里（函数自己身上的时间）', sorted(byOwner))
  table(`自己最费的函数（前 ${TOP} 个）`, sorted(bySelf).slice(0, TOP))
  table(
    `适配器自己的函数，连它调的都算上（前 ${TOP} 个）`,
    sorted(byTotal)
      .filter(([name]) => /packages\/[a-z]+\/dist\//.test(name))
      .slice(0, TOP),
  )
}
