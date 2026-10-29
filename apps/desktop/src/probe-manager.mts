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
  endingReadOnly: boolean
  endingListed: boolean
  endCompleted: boolean
  answerEvent: boolean
  omittedActions: boolean
  itemReasons: boolean
  decisionJump: boolean
  overviewUnique: boolean
  opening: boolean
  localizedRules: boolean
  endedRow: boolean
  branchFacts: boolean
  settingsSaved: boolean
  settingsKept: boolean
  settingsCancelled: boolean
  settingsReadOnly: boolean
  settingsValidation: boolean
  dispatchSaved: boolean
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
  const ended = one('[data-manager-row="e1"] .mg-list-open')
  const summary = one('[data-manager-row="e1"] > button.btn')
  const rowBox = ended?.getBoundingClientRect()
  const summaryBox = summary?.getBoundingClientRect()
  const endedRow = Boolean(
    ended &&
      !/0 条线在跑|—/.test(ended.textContent ?? '') &&
      rowBox &&
      summaryBox &&
      summaryBox.top >= rowBox.top &&
      summaryBox.bottom <= rowBox.bottom,
  )
  await click('[data-manager-id="m1"] .mg-pick')
  const selected = Boolean(await until('经理页', () => one('[data-manager="session"]')))
  // 窄窗口中先切到看板；宽窗口同一组按钮不显示，不需要点。
  const narrow = one<HTMLButtonElement>('.mg-narrow button:last-child')
  if (narrow && narrow.getBoundingClientRect().height > 0) narrow.click()
  await until('概览事项', () => one('[data-overview="blocked"] .mg-item'))
  const overviewUnique =
    document.querySelectorAll('[data-manager-item="I-4"]').length === 1 &&
    !one('[data-overview="yours"] [data-manager-item="I-4"]') &&
    !one('.mg-item > .pill')
  await until('经理开场', () => one('.mg-chat .umsg'))
  const opening =
    Boolean(one('.mg-chat')?.textContent?.includes('请负责「Litch 0.23」')) &&
    !one('.mg-chat')?.textContent?.includes('占位回答')
  await click('[data-overview="blocked"] [data-decision-link="D-16"]')
  const decisionJump = await until(
    '定位到关联决策',
    () =>
      document.activeElement?.getAttribute('data-decision') === 'D-16' &&
      one('[data-board-tab="decisions"]')?.getAttribute('aria-selected') === 'true',
  )
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
  const answerEvent = Boolean(one('[data-event="manager-answers"]'))
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
  const reason = one('[data-manager-item="I-2"] .mg-item-reason')?.textContent ?? ''
  const itemReasons = reason.match(/D-15/g)?.length === 1 && !one('.mg-item > .pill')
  await click('[data-manager-item="I-2"] [data-decision-link="D-15"]')
  await until(
    '已答决策也能定位',
    () =>
      document.activeElement?.getAttribute('data-decision') === 'D-15' &&
      !one('[data-decision="D-15"] textarea'),
  )
  await click('[data-board-tab="lines"]')
  const panels = Boolean(await until('工作线事实', () => one('.mg-body .mg-unverified')))
  const branchFacts = ![...document.querySelectorAll('.mg-body .mg-card > p')].some(
    (paragraph) => paragraph.textContent?.trim() === '未知',
  )
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
    one<HTMLTextAreaElement>('.mg-rules textarea')?.value.includes('同时最多运行 4 条工作线'),
  )
  const rules = one<HTMLTextAreaElement>('.mg-rules textarea')
  const max = field('同时最多几条线')?.querySelector('input')
  if (!rules || !max) throw new Error('经理表单缺少规矩或派活字段')
  const look = (
    window as unknown as { __litchLook: { set(patch: { lang: 'zh-CN' | 'en' }): void } }
  ).__litchLook
  look.set({ lang: 'en' })
  await until('英文规矩', () => rules.value.includes('At most 4 lines'))
  fill(max, '3')
  await until('选项更新英文规矩', () => rules.value.includes('At most 3 lines'))
  look.set({ lang: 'zh-CN' })
  const localizedRules = await until(
    '中文规矩跟随设置',
    () =>
      rules.value.includes('同时最多运行 3 条工作线') &&
      !rules.value.includes('Default line harness'),
  )
  await click('.mg-rules button')
  fill(rules, '仅执行冒烟验收范围内的任务。')
  fill(max, '2')
  const rulesKept = await until(
    '手写规矩保持原文',
    () => rules.value === '仅执行冒烟验收范围内的任务。' && max.value === '2',
  )
  look.set({ lang: 'en' })
  await until(
    '切语言仍保留手写规矩',
    () => rules.value === '仅执行冒烟验收范围内的任务。' && document.documentElement.lang === 'en',
  )
  look.set({ lang: 'zh-CN' })
  await until('恢复中文', () => document.documentElement.lang === 'zh-CN')
  await click('.mg-form button[type="submit"]')
  const created = await until('建好后进入经理', () =>
    one('.mg-title')?.textContent?.includes('经理冒烟验收'),
  )
  const createdId = one('[data-manager="session"]')?.getAttribute('data-manager-id')
  await click('[data-act="manager-settings"]')
  await until('编辑经理表单', () => one('[data-manager-mode="edit"]'))
  const editField = (label: string) => {
    const input = field(label)?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    )
    if (!input) throw new Error(`缺少设置字段：${label}`)
    return input
  }
  const settingsReadOnly =
    document.querySelectorAll('.mg-fixed').length === 5 &&
    !field('工作目录')?.querySelector('input') &&
    !field('第一件事') &&
    !field('从哪种开始')
  fill(editField('名字'), '经理设置验收')
  fill(editField('范围'), '   ')
  await click('.mg-form button[type="submit"]')
  const settingsValidation = Boolean(
    await until('无效范围显示原因', () => one('.mg-form [role="alert"]')),
  )
  fill(editField('范围'), '修改后的经理验收范围')
  fill(editField('同时最多几条线'), '5')
  const select = async (label: string, value: string) => {
    const input = field(label)?.querySelector('select')
    if (!input) throw new Error(`缺少设置选项：${label}`)
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const lineModel = await until(
    '子会话模型选项',
    () => field('子会话模型')?.querySelector('select')?.options[1]?.value,
  )
  await select('子会话模型', lineModel)
  await select('谁来合并', 'user')
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    '.mg-fields input[type="checkbox"]',
  ))
    checkbox.click()
  const settingsKept = await until(
    '编辑设置保留规矩',
    () => one<HTMLTextAreaElement>('.mg-rules textarea')?.value === '仅执行冒烟验收范围内的任务。',
  )
  await click('.mg-form button[type="submit"]')
  const settingsSaved = await until(
    '更新名字、范围和规矩事件',
    () =>
      one('.mg-title')?.textContent?.includes('经理设置验收') &&
      one('.crumb')?.textContent?.includes('经理设置验收') &&
      one(`.mg-sidebar-manager[data-manager-id="${createdId}"] .mg-pick`)?.textContent?.includes(
        '经理设置验收',
      ) &&
      one('.mg-scope')?.textContent?.includes('修改后的经理验收范围') &&
      Boolean(one('[data-event="manager-rules"]')),
  )
  await click('[data-act="manager-settings"]')
  await until('重新打开保存的并发上限', () => editField('同时最多几条线').value === '5')
  const dispatchSaved =
    field('子会话模型')?.querySelector('select')?.value === lineModel &&
    field('谁来合并')?.querySelector('select')?.value === 'user' &&
    [...document.querySelectorAll<HTMLInputElement>('.mg-fields input[type="checkbox"]')].every(
      (input) => !input.checked,
    )
  fill(editField('范围'), '取消的修改不应保存')
  await click('.mg-form-foot button[type="button"]')
  const settingsCancelled = await until('取消不保存', () =>
    one('.mg-scope')?.textContent?.includes('修改后的经理验收范围'),
  )
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-row="e1"] .mg-list-open')
  await click('[data-board-tab="decisions"]')
  const endedReadOnly = Boolean(
    await until(
      '已结束看板只读',
      () =>
        one('.mg-readonly') &&
        one('.mg-decision textarea:disabled') &&
        !one('[data-act="manager-settings"]'),
    ),
  )
  await click('[data-manager-id="m1"] .mg-pick')
  await until('回到主经理', () => one('[data-manager="session"][data-manager-id="m1"]'))
  await click('[data-board-tab="decisions"]')
  await click('[data-act="manager-end"]')
  await click('.mg-end button:last-child')
  await until('先进入结束中', () => one('[data-manager-status="ending"]'))
  const endingReadOnly = Boolean(
    one('.mg-title')?.textContent?.includes('结束中') &&
      one('.mg-readonly')?.textContent?.includes('正在收尾') &&
      !one('.mg-title button') &&
      !one('.mg-chat textarea') &&
      one('.mg-decision textarea:disabled') &&
      one('.mg-sidebar-group:first-child [data-manager-id="m1"]')?.textContent?.includes('结束中'),
  )
  await click('[data-sidebar-mode="manager"]')
  const endingListed = Boolean(
    await until('全部经理显示结束中', () =>
      one('[data-manager-row="m1"]')?.textContent?.includes('结束中'),
    ),
  )
  await click('[data-manager-row="m1"] .mg-list-open')
  await until('收尾回合完成后结束', () => one('[data-manager-status="ended"]'))
  await click('[data-board-tab="decisions"]')
  const endCompleted = Boolean(
    one('.mg-title')?.textContent?.includes('已结束') &&
      !one('.mg-chat textarea') &&
      one('.mg-decision textarea:disabled') &&
      !one('.mg-sidebar-group:first-child [data-manager-id="m1"]'),
  )
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
    endingReadOnly,
    endingListed,
    endCompleted,
    answerEvent,
    omittedActions,
    itemReasons,
    decisionJump,
    overviewUnique,
    opening,
    localizedRules,
    endedRow,
    branchFacts,
    settingsSaved,
    settingsKept,
    settingsCancelled,
    settingsReadOnly,
    settingsValidation,
    dispatchSaved,
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
    endingReadOnly: '结束中经理未标明状态或仍能写入',
    endingListed: '结束中经理未保留在全部经理列表',
    endCompleted: '收尾回合结束后经理未转已结束只读',
    answerEvent: '看板答复回合没有显示经理事件',
    omittedActions: '仍显示第一版不支持的操作',
    itemReasons: '事项原因重复决策编号或状态标签',
    decisionJump: '点击决策编号没有切页并定位',
    overviewUnique: '卡住的用户事项在概览重复出现',
    opening: '经理对话仍使用 id 或占位回答开场',
    localizedRules: '规矩初稿没有跟随界面语言和设置',
    endedRow: '已结束经理有无效占位或总结按钮错位',
    branchFacts: '工作线仍显示孤立的未知',
    settingsSaved: '设置保存后名字、范围或规矩事件未更新',
    settingsKept: '编辑经理时原有规矩被选项覆盖',
    settingsCancelled: '取消设置仍保存了修改',
    settingsReadOnly: '编辑经理仍能修改设备、目录或经理自身运行配置',
    settingsValidation: '无效设置没有显示原因并保留表单',
    dispatchSaved: '子会话模型、工作树、合并方式或通知设置没有保存',
  }
  return (Object.keys(messages) as (keyof ManagerSeen)[])
    .filter((key) => !seen[key])
    .map((key) => messages[key])
}
