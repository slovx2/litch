// 手工分段测量：真 git + 完整源码副本 + 大量被忽略文件，设备进程和假引擎；不访问个人 harness 配置。
// 用法：npm run build --prefix packages/device && node scripts/bench-proposal-start.mjs [源码仓库]
// 假引擎只能量设备与 git 路径，不能替代用户远程设备的真实 harness 冷启动数据。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resultOf } from '../packages/device/dist/device/test/fake-engine.mjs'
import { brief, treeRig } from '../packages/device/dist/device/test/tree-kit.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifact = join(root, '.artifacts', `proposal-start-${Date.now()}`)
const source = resolve(process.argv[2] ?? root)
const repo = join(artifact, 'repo')
mkdirSync(artifact, { recursive: true })
execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source, repo], { stdio: 'pipe' })
// 10 万个被忽略文件：覆盖 git ls-files 遍历依赖/构建缓存的开销，内容完全为夹具生成。
for (let i = 0; i < 5000; i++) {
  const dir = join(repo, 'node_modules', `fixture-${i}`, 'lib')
  mkdirSync(dir, { recursive: true })
  for (let j = 0; j < 20; j++) writeFileSync(join(dir, `${j}.js`), 'export default 1\n')
}
const logs = []
const env = treeRig({}, { log: (line) => logs.push(line) })
const output = []
try {
  const client = env.connect()
  await client.initialize(['harness', 'sessionTree', 'worktrees', 'clientTools'])
  const started = await client.call('thread/start', { harness: 'pi', cwd: repo })
  const threadId = started.thread.id
  await client.call('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'fixture', text_elements: [] }],
  })
  for (const worktree of [false, true, true]) {
    const answer = await env.pi.callTool(threadId, 'litch_sessions', 'start', {
      title: '测量建议开始',
      ...brief('测量建议开始'),
      initiation: 'propose',
      worktree,
    })
    const proposalId = resultOf(answer.answer).proposal_id
    const begin = performance.now()
    const child = await client.call('litch/sessionProposal/accept', { proposalId })
    const ack = performance.now()
    await client.call('thread/read', { threadId: child.threadId, includeTurns: true })
    output.push({
      worktree,
      acceptMs: Math.round(ack - begin),
      adoptReadMs: Math.round(performance.now() - ack),
      logs: logs.splice(0).filter((line) => line.includes('.timing')),
    })
    env.pi.end(child.threadId)
  }
  const result = {
    repo,
    trackedFiles: execFileSync('git', ['-C', repo, 'ls-files', '-z'])
      .toString()
      .split('\0')
      .filter(Boolean).length,
    ignoredFiles: 100000,
    fakeHarness: true,
    output,
  }
  writeFileSync(join(artifact, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
} finally {
  // 设备与它新建的工作树仅在隔离状态目录中；源码副本和报告保留供复核。
  await env.close()
}
