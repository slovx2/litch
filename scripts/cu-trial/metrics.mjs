// 只读统计：并发工具区间取并集，避免把重叠耗时误算成模型之外的墙钟。
export function metrics(calls, turns) {
  const intervals = calls
    .map((call) => [Date.parse(call.at), Date.parse(call.at) + call.durationMs])
    .sort((a, b) => a[0] - b[0])
  let occupiedMs = 0,
    end = -Infinity
  for (const [start, stop] of intervals) {
    occupiedMs += Math.max(0, stop - Math.max(start, end))
    end = Math.max(end, stop)
  }
  const wallMs = turns.reduce((total, turn) => total + turn.durationMs, 0)
  const batches = calls.filter((call) => call.tool === 'run_actions')
  const attempted = batches.reduce((total, call) => {
    const summary = call.result.contentItems.find((item) => item.type === 'inputText')?.text ?? ''
    return total + [...summary.matchAll(/^\d+\. /gm)].length
  }, 0)
  return {
    calls: calls.length,
    failures: calls.filter((call) => !call.result.success).length,
    batchCalls: batches.length,
    averageBatchSteps: batches.length ? attempted / batches.length : 0,
    toolMs: calls.reduce((total, call) => total + call.durationMs, 0),
    occupiedMs,
    wallMs,
    outsideToolMs: wallMs - occupiedMs,
    noChanges: calls.filter((call) =>
      call.result.contentItems.some(
        (item) =>
          item.type === 'inputText' && item.text.includes('(no changes since the last state)'),
      ),
    ).length,
  }
}
