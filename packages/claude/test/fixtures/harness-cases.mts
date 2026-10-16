import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test, { before, describe } from 'node:test'
import { MockLLM } from './mock-llm.mjs'
import { ProtocolClient } from './protocol-client.mjs'

// 不是用例文件：由 test-harness.test.mts 另起测试进程运行，复现用例来不及自己收尾的几种情形。
const home = process.env.HARNESS_CASE_HOME
if (!home) throw new Error('只能由 test-harness 用例启动')

// 适配器在钩子里启动：用例的时限从它启动完成之后才开始算，慢机器上不会在适配器起来之前就超时。
describe('适配器已经启动', () => {
  before(async () => {
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start(), true)
    await writeFile(join(home, 'adapter.pid'), String(client.process.pid))
  })
  test('卡在等不到的事件上', { timeout: 1_000 }, async () => {
    await new Promise(() => {})
  })
})

test('留下监听端口后失败', async () => {
  const site = createServer(() => {})
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  throw new Error('收尾之前就失败')
})

test('没有指定隔离 CLI', async () => {
  const model = new MockLLM()
  await ProtocolClient.start(home, await model.start())
})
