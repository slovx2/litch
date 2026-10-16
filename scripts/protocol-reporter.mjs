// Node 测试事件是真实执行结果，覆盖门禁不得以存在测试源文件作为成功证据。
export default async function* report(source) {
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue
    yield JSON.stringify({
      runId: process.env.PROTOCOL_RUN_ID,
      engine: 'claude-code',
      caseName: event.data.name,
      status:
        event.type === 'test:pass' && !event.data.skip && !event.data.todo ? 'passed' : 'failed',
      caseIds: event.data.name.match(/\b[A-Z]+-[A-Za-z0-9-]+/g) ?? [],
    }) + '\n'
  }
}
