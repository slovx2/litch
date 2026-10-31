// 在隔离模拟窗口里核对子代理的两种协议表示：活动标记独立出现，以及与协作调用同时出现。
import type { BrowserWindow } from 'electron'

async function probe() {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (check: () => boolean) => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if (check()) return
      await sleep(30)
    }
    throw new Error(`子代理活动验收等待超时：${check}`)
  }
  const latest = () => [...document.querySelectorAll<HTMLElement>('.main .tr > .turn')].at(-1)
  const rows = () => [...(latest()?.querySelectorAll<HTMLElement>('.agent-row') ?? [])]
  const select = async (id: string) => {
    document.querySelector<HTMLElement>(`.row-line[data-session="${id}"] .ss-row`)?.click()
    await until(
      () => document.querySelector(`.row-line[data-session="${id}"] .ss-row.sel`) !== null,
    )
    await sleep(200)
  }
  const reveal = () =>
    latest()?.querySelector<HTMLElement>('.proc-head[aria-expanded="false"]')?.click()
  const results = []
  await select('s6')
  for (const prompt of ['用Codex子代理', '用子代理']) {
    const input = document.querySelector<HTMLTextAreaElement>('.main .dock textarea.cmp-text')
    if (!input) throw new Error('找不到夹具输入框')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      input,
      prompt,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(50)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await until(() => rows().length === 3 && rows().some((row) => row.dataset.state === 'running'))
    const ids = rows().map((row) => row.dataset.agent)
    await until(() => !document.querySelector('.main .dock .send.stop'))
    reveal()
    await until(
      () =>
        rows()
          .map((row) => row.dataset.state)
          .join(',') === 'completed,stopped,failed',
    )
    const text = latest()?.textContent ?? ''
    const uniform = rows().length === 3 && !text.includes('/root/') && !text.includes('子代理活动')
    const descriptions = rows().map((row) => row.querySelector('.agent-desc')?.textContent)
    // 切走再回来：重新分块、重新挂载不能把活动标记变回提示框，也不能重复出行。
    await select('s1')
    await select('s6')
    reveal()
    await until(() => rows().length === 3)
    const restored = rows().every((row, index) => row.dataset.agent === ids[index])
    rows()[0]?.click()
    await until(
      () => document.querySelector(`.side .agents-view[data-agent="${ids[0]}"] .tr .turn`) !== null,
    )
    const opens =
      document.querySelector(
        `.side .bg-row[data-entry="agent:${ids[0]}"][aria-selected="true"]`,
      ) !== null
    document.querySelector<HTMLElement>('.side [data-tool="hide"]')?.click()
    results.push({ prompt, uniform, restored, opens, descriptions })
  }
  return results
}

export async function checkAgentActivity(window: BrowserWindow) {
  const results = await window.webContents.executeJavaScript(`(${probe.toString()})()`)
  return {
    results,
    failed: results.every(
      (row: { uniform: boolean; restored: boolean; opens: boolean }) =>
        row.uniform && row.restored && row.opens,
    )
      ? []
      : ['子代理活动的统一行、恢复或详情跳转失败'],
  }
}
