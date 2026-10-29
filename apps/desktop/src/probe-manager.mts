// 经理冒烟只操作正式界面，模拟核心负责写答案和生成答复回合。
export interface ManagerSeen {
  list: boolean
  selected: boolean
  draft: boolean
  submitted: boolean
  turnAdded: boolean
  isolated: boolean
  draftKept: boolean
  reopened: boolean
  panels: boolean
  childReturn: boolean
  created: boolean
  rulesKept: boolean
  endedReadOnly: boolean
  omittedActions: boolean
}

export async function managerProbe(): Promise<ManagerSeen> {
  const one = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)
  const click = (selector: string) =>
    until(selector, () => one<HTMLButtonElement>(selector)).then((button) => button.click())
  const fill = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const until = async <T,>(what: string, read: () => T | null | false | undefined): Promise<T> => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      const value = read()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(`经理冒烟等待超时：${what}`)
  }
  ;(await until('经理入口', () => one<HTMLButtonElement>('[data-sidebar-mode="manager"]'))).click()
  const list = Boolean(await until('全部经理页', () => one('[data-manager="list"]')))
  await click('[data-manager-id="m1"] .mg-pick')
  const selected = Boolean(await until('经理页', () => one('[data-manager="session"]')))
  // 窄窗口中先切到看板；宽窗口同一组按钮不显示，不需要点。
  const narrow = one<HTMLButtonElement>('.mg-narrow button:last-child')
  if (narrow && narrow.getBoundingClientRect().height > 0) narrow.click()
  ;(await until('决策页签', () => one<HTMLButtonElement>('[data-board-tab="decisions"]'))).click()
  ;(await until('按推荐', () => one<HTMLButtonElement>('[data-act="manager-recommend"]'))).click()
  const draft = Boolean(await until('本地草稿', () => one('.mg-decision[data-draft="true"]')))
  await click('[data-manager-id="m3"] .mg-pick')
  await until('另一位经理', () => one('[data-manager="session"][data-manager-id="m3"]'))
  await click('[data-manager-id="m1"] .mg-pick')
  await until('返回原经理', () => one('[data-manager="session"][data-manager-id="m1"]'))
  await click('[data-board-tab="decisions"]')
  const draftKept = Boolean(
    await until('切页保留草稿', () => one('.mg-decision[data-draft="true"] input:checked')),
  )
  await until('已有对话回合', () => one('.mg-chat .turn'))
  const before = document.querySelectorAll('.mg-chat .turn').length
  ;(
    await until('提交按钮', () => {
      const button = one<HTMLButtonElement>('[data-act="manager-submit"]')
      return button && !button.disabled ? button : null
    })
  ).click()
  const submitted = await until(
    '答复写入看板',
    () => !one('.mg-send') && Boolean(one('.mg-decision')),
  )
  const turnAdded = await until(
    '对话新增一回合',
    () => document.querySelectorAll('.mg-chat .turn').length > before,
  )
  await click('.mg-decision-filter button:last-child')
  await until('已关闭的决策', () => one('[data-decision="D-12"]'))
  await click('[data-decision="D-12"] button')
  const reopened = Boolean(
    await until('决策重新打开', () => one('[data-decision="D-12"] textarea')),
  )
  const omittedActions = ![...document.querySelectorAll('.mg-board button')].some((button) =>
    /^(仍然有效|推迟)$/.test(button.textContent?.trim() ?? ''),
  )
  await click('[data-board-tab="items"]')
  await until('事项分组', () => one('.mg-body details .mg-item'))
  await click('[data-board-tab="lines"]')
  const panels = Boolean(await until('工作线事实', () => one('.mg-body .mg-unverified')))
  await click('.mg-body .mg-card button')
  await until('子会话来源', () => one('.mg-origin'))
  await click('.mg-origin button')
  const childReturn = Boolean(
    await until('回到经理', () => one('[data-manager="session"][data-manager-id="m1"]')),
  )
  const childIds = [...document.querySelectorAll('.mg-tree [data-session]')]
    .map((row) => row.getAttribute('data-session'))
    .filter(Boolean)
  one<HTMLButtonElement>('[data-sidebar-mode="chat"]')?.click()
  await until('返回普通对话', () => !one('.mg-sidebar-manager'))
  const isolated =
    childIds.length > 0 &&
    childIds.every(
      (id) => !document.querySelector(`.sb-scroll [data-session="${CSS.escape(id ?? '')}"]`),
    )
  await click('[data-sidebar-mode="manager"]')
  await click('.sb-top .new')
  await until('新建经理表单', () => one('[data-manager="form"]'))
  const field = (label: string) =>
    [...document.querySelectorAll<HTMLLabelElement>('.mg-form label')].find(
      (entry) => entry.firstChild?.textContent?.trim() === label,
    )
  const nameInput = field('名字')?.querySelector('input')
  const scopeInput = field('范围')?.querySelector('textarea')
  const cwdInput = field('工作目录')?.querySelector('input')
  if (!nameInput || !scopeInput || !cwdInput) throw new Error('经理表单缺少必填字段')
  fill(nameInput, '经理冒烟验收')
  fill(scopeInput, '验证经理表单和答复提交，不启动真实任务')
  fill(cwdInput, '~/work/litch')
  await until('规矩初稿', () =>
    one<HTMLTextAreaElement>('.mg-rules textarea')?.value.includes('At most 4'),
  )
  await click('.mg-rules button')
  const rules = one<HTMLTextAreaElement>('.mg-rules textarea')
  const max = field('同时最多几条线')?.querySelector('input')
  if (!rules || !max) throw new Error('经理表单缺少规矩或派活字段')
  fill(rules, '仅执行冒烟验收范围内的任务。')
  fill(max, '2')
  const rulesKept = await until(
    '手写规矩保持原文',
    () => rules.value === '仅执行冒烟验收范围内的任务。' && max.value === '2',
  )
  await click('.mg-form button[type="submit"]')
  const created = await until('建好后进入经理', () =>
    one('.mg-title')?.textContent?.includes('经理冒烟验收'),
  )
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-row="e1"] .mg-list-open')
  await click('[data-board-tab="decisions"]')
  const endedReadOnly = Boolean(
    await until(
      '已结束看板只读',
      () => one('.mg-readonly') && one('.mg-decision textarea:disabled'),
    ),
  )
  await click('[data-manager-id="m1"] .mg-pick')
  await until('回到主经理', () => one('[data-manager="session"][data-manager-id="m1"]'))
  return {
    list,
    selected,
    draft,
    submitted,
    turnAdded,
    isolated,
    draftKept,
    reopened,
    panels,
    childReturn,
    created,
    rulesKept,
    endedReadOnly,
    omittedActions,
  }
}

export function judgeManager(seen: ManagerSeen): string[] {
  const messages: Record<keyof ManagerSeen, string> = {
    list: '切换后没有全部经理页',
    selected: '没有打开经理页',
    draft: '答复没有标为本地草稿',
    submitted: '答复没有提交到看板',
    turnAdded: '提交后对话没有新增回合',
    isolated: '经理子会话漏进普通对话目录',
    draftKept: '切换经理后草稿丢失',
    reopened: '已关闭决策没有重新打开',
    panels: '事项或工作线没有显示事实',
    childReturn: '子会话没有返回经理',
    created: '新建经理没有进入经理页',
    rulesKept: '手写规矩被派活选项覆盖',
    endedReadOnly: '已结束经理没有转只读',
    omittedActions: '仍显示第一版不支持的操作',
  }
  return (Object.keys(messages) as (keyof ManagerSeen)[])
    .filter((key) => !seen[key])
    .map((key) => messages[key])
}
