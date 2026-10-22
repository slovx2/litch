import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { approvalHarness } from './approval-harness.mjs'

// 用户级 mcp.json 里有连不上的 MCP 服务时，回合照常：Pi 在会话开始时连 MCP，连不上的只记一笔
// （/mcp 里显示 failed），不该让建会话或回合失败。Claude 入口出过同类问题：一个 HTTP 服务的端口
// 没人听（ECONNREFUSED），整个回合 0 毫秒失败、报 fetch failed。
// 真实 Pi SDK、回环上的假模型。

/** 一个此刻没人监听的回环端口：先占一个再放掉 */
async function deadPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

test('MCP-PI-001：mcp.json 里的 HTTP 服务端口没人听、stdio 命令不存在，建会话和回合照常', {
  timeout: 60000,
}, async () => {
  const port = await deadPort()
  const h = await approvalHarness({
    approvals: false,
    prepare: async (agentDir, root) => {
      // 一个连得上的服务作对照：它的工具出现在给模型的工具里，说明 mcp.json 确实被读了、连接确实试过
      const alive = join(root, 'mcp-alive.mjs')
      await writeFile(
        alive,
        `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 let result={};
 if(request.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'alive',version:'1.0.0'}};
 if(request.method==='tools/list')result={tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{}}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
      )
      await writeFile(
        join(agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            alive: { command: process.execPath, args: [alive], exposure: 'direct' },
            refused: { url: `http://127.0.0.1:${port}/mcp`, exposure: 'direct' },
            missing: { command: join(root, 'no-such-mcp-command'), exposure: 'direct' },
          },
        }),
      )
    },
  })
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    h.steps.push({ text: '第一回' })
    const first = await c.completed(await c.start(threadId, '你好'))
    assert.equal(first.status, 'completed', `回合不该失败：${JSON.stringify(first.error)}`)
    assert.equal(first.error, null)
    assert.equal(h.requests.length, 1, '模型应当被请求到')
    // 连得上的服务的工具在，连不上的没有
    const names = (h.requests[0].tools ?? []).map((tool: any) => tool.function.name)
    assert.ok(names.includes('mcp__alive__echo'), `应当有对照服务的工具：${names.join(', ')}`)
    assert.ok(
      names.every((name: string) => !/^mcp__(refused|missing)__/.test(name)),
      `不该有连不上的服务的工具：${names.join(', ')}`,
    )
    // 连不上的照 Pi 自己的做法报一次提醒（会话开始时汇总），不算回合出错
    const warnings = c.notifications('warning').map((m: any) => m.params.message as string)
    assert.equal(warnings.length, 1, `应当提醒一次：${JSON.stringify(warnings)}`)
    const [warning = ''] = warnings
    assert.match(warning, /refused: failed/)
    assert.match(warning, /missing: failed: .*ENOENT/)
    assert.doesNotMatch(warning, /alive/)
    const agent = c.item(
      c.messages.findLast(
        (m) => m.method === 'item/completed' && m.params.item.type === 'agentMessage',
      )?.params.item.id,
    )
    assert.equal(agent?.text, '第一回')
    // 同一个会话的下一个回合同样照常
    h.steps.push({ text: '第二回' })
    const second = await c.completed(await c.start(threadId, '再来'))
    assert.equal(second.status, 'completed', `第二个回合不该失败：${JSON.stringify(second.error)}`)
    assert.equal(h.requests.length, 2)
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})
