// 发版必跑：真实窗口上的输入法、发送和关键审批。长矩阵仍由 compose 在夜间/受影响时执行。
// 此函数会序列化到渲染进程，不能引用外部变量。
export async function criticalProbe(real: boolean): Promise<Record<string, boolean>> {
  const one = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)
  const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const until = async <T,>(name: string, read: () => T | false | null | undefined) => {
    const end = performance.now() + 30_000
    while (performance.now() < end) {
      const value = read()
      if (value) return value
      await new Promise<void>((resolve) => setTimeout(resolve, 16))
    }
    throw new Error(`关键链路等不到：${name}`)
  }
  const press = (element: Element, key: string, extra: KeyboardEventInit = {}) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    )
  const rows = () => all('.ss-row:not(.projection-group *)')
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const open = async (title: string) => {
    const row = await until(`会话 ${title}`, () =>
      rows().find((entry) => entry.textContent?.includes(title)),
    )
    row.click()
    await until(
      `会话 ${title} 已就绪`,
      () =>
        one('.crumb')?.textContent?.includes(title) &&
        area() &&
        one('.tr-scroll')?.getAttribute('aria-busy') === 'false',
    )
    await frame()
  }
  const result: Record<string, boolean> = {}
  if (!real) {
    await open('聚合面')
    const approval = await until('命令审批卡片', () => one<HTMLElement>('.req'))
    await until('审批卡片焦点', () => document.activeElement === approval)
    const row = await until('审批卡片之外的会话行', () => rows()[0])
    row.focus()
    press(row, 'Enter')
    await frame()
    await frame()
    result.strayEnterIgnored = approval.isConnected && one('.req') === approval
    approval.focus()
    press(approval, 'Escape')
    const tool = await until('拒绝后接续工具审批', () => {
      const card = one('.req')
      return card && card !== approval && card.textContent?.includes('tracker') ? card : null
    })
    await until('工具审批焦点', () => document.activeElement === tool)
    result.declined = !approval.isConnected
    result.approvalActions = all('.req-actions .btn').length === 5
    press(tool, 'Enter')
    await until(
      '批准后卡片收起并返回输入框',
      () => !one('.req') && document.activeElement === area(),
    )
    result.accepted = !tool.isConnected
  }
  await open(real ? '给首页加一个状态条' : '远程设备安装指引')
  const input = await until('输入框', area)
  const words = '发版关键链路发送核验'
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, words)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await frame()
  press(input, 'Enter', { isComposing: true })
  await frame()
  await frame()
  const matches = () => all('.umsg-text').filter((entry) => entry.textContent === words)
  result.imeKept = input.value === words && matches().length === 0
  await until('发送按钮可用', () => {
    const button = one<HTMLButtonElement>('.dock .send:not(.stop)')
    return button && !button.disabled
  })
  press(input, 'Enter')
  const message = await until('对应消息出现', () => matches()[0])
  const id = message.closest('.turn')?.getAttribute('data-search-turn')
  if (!id) throw new Error('发送后的消息没有回合标识')
  const turn = () => all('.turn').find((entry) => entry.getAttribute('data-search-turn') === id)
  await until('对应回合完成并显示回答', () => {
    const entry = turn()
    return (
      entry?.querySelector('.turn-foot') &&
      entry.querySelector('.md') &&
      !entry.querySelector('.running-line, .md.live')
    )
  })
  result.sentOnce = matches().length === 1 && area()?.value === ''
  result.completed = Boolean(turn()?.querySelector('.turn-foot')?.textContent?.includes('完成'))
  if (real) result.echoed = Boolean(turn()?.textContent?.includes(`收到：${words}`))
  return result
}

export const judgeCritical = (result: Record<string, boolean>): string[] =>
  Object.entries(result)
    .filter(([, passed]) => !passed)
    .map(([name]) => `关键链路失败：${name}`)
