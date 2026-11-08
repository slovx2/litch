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
    document
      .querySelector<HTMLElement>(
        `.row-line[data-session="${id}"]:not(.projection-group *) .ss-row:not(.projection-group *)`,
      )
      ?.click()
    await until(
      () =>
        document.querySelector(
          `.row-line[data-session="${id}"]:not(.projection-group *) .ss-row:not(.projection-group *).sel`,
        ) !== null,
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
    // 展开长任务后不再裁剪；标题、按钮不与正文重叠，顶部自己滚动。覆盖三皮肤、明暗和窄面板。
    const taskLayouts: boolean[] = []
    const taskMeasurements: unknown[] = []
    const view = document.querySelector<HTMLElement>('.side .agents-view')
    const look = (
      window as unknown as { __litchLook: { set(p: { skin?: string; theme?: string }): void } }
    ).__litchLook
    const was = {
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
    }
    document
      .querySelector<HTMLElement>('.side .agents-task[data-open="false"] .agents-task-more')
      ?.click()
    await sleep(50)
    if (view) {
      for (const skin of ['standard', 'retro', 'human']) {
        for (const theme of ['light', 'dark']) {
          look.set({ skin, theme })
          for (const width of [280, 560]) {
            view.style.width = `${width}px`
            await sleep(30)
            const body = view.querySelector<HTMLElement>('.agents-task-text')!
            const label = view.querySelector<HTMLElement>('.agents-task-label')!
            const more = view.querySelector<HTMLElement>('.agents-task-more')!
            const head = view.querySelector<HTMLElement>('.agents-head')!
            const box = body.getBoundingClientRect()
            taskMeasurements.push({
              skin,
              theme,
              width,
              bodyHeight: body.clientHeight,
              bodyScroll: body.scrollHeight,
              labelBottom: label.getBoundingClientRect().bottom,
              bodyTop: box.top,
              bodyBottom: box.bottom,
              moreTop: more.getBoundingClientRect().top,
              headHeight: head.clientHeight,
              headScroll: head.scrollHeight,
              open: body.parentElement?.dataset.open,
              display: getComputedStyle(body).display,
            })
            taskLayouts.push(
              (body.textContent?.includes('任务结束：提交结构概览与引用位置。') ?? false) &&
                body.scrollHeight <= body.clientHeight + 1 &&
                label.getBoundingClientRect().bottom <= box.top &&
                more.getBoundingClientRect().top >= box.bottom &&
                head.scrollHeight > head.clientHeight,
            )
          }
        }
      }
      view.style.removeProperty('width')
    }
    look.set({
      ...(was.skin ? { skin: was.skin } : {}),
      ...(was.theme ? { theme: was.theme } : {}),
    })
    document.querySelector<HTMLElement>('.side [data-tool="hide"]')?.click()
    results.push({ prompt, uniform, restored, opens, descriptions, taskLayouts, taskMeasurements })
  }
  return results
}

export async function checkAgentActivity(window: BrowserWindow) {
  const results = await window.webContents.executeJavaScript(`(${probe.toString()})()`)
  return {
    results,
    failed: results.every(
      (row: { uniform: boolean; restored: boolean; opens: boolean; taskLayouts: boolean[] }) =>
        row.uniform &&
        row.restored &&
        row.opens &&
        row.taskLayouts.length === 12 &&
        row.taskLayouts.every(Boolean),
    )
      ? []
      : ['子代理活动的统一行、恢复、详情跳转或长任务布局失败'],
  }
}
