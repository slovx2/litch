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
  reportsStopped: boolean
  reportsResumed: boolean
  created: boolean
  promptKept: boolean
  endedReadOnly: boolean
  endingReadOnly: boolean
  endingListed: boolean
  endCompleted: boolean
  answerEvent: boolean
  createdEvent: boolean
  rulesEvent: boolean
  endEvent: boolean
  eventsClean: boolean
  omittedActions: boolean
  itemReasons: boolean
  decisionJump: boolean
  overviewUnique: boolean
  opening: boolean
  promptLocalized: boolean
  endedRow: boolean
  branchFacts: boolean
  settingsSaved: boolean
  settingsKept: boolean
  settingsCancelled: boolean
  settingsReadOnly: boolean
  settingsValidation: boolean
  dispatchSaved: boolean
  chatRestored: boolean
  managerRestored: boolean
  lineRestored: boolean
  settingsRestored: boolean
  createdKeepsChat: boolean
  archivedFallback: boolean
  externalChat: boolean
  externalKeepsManager: boolean
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
    throw new Error(
      `经理冒烟等待超时：${what}；${JSON.stringify({
        page: one('[data-manager]')?.getAttribute('data-manager'),
        title: one('.mg-title')?.textContent,
        crumb: one('.crumb')?.textContent,
        error: one('.mg-form [role="alert"]')?.textContent,
      })}`,
    )
  }
  const cleanChat = () => !one('.mg-chat')?.textContent?.includes('<litch-session-event')
  const eventBody = async (kind: string) => {
    const selector = `.mg-chat [data-event="${kind}"]`
    await until(`${kind} 事件卡`, () => one(selector))
    if (!one(`${selector} .sev-body`)) await click(`${selector} button`)
    return until(`${kind} 事件正文`, () => one(`${selector} .sev-body`))
  }
  await click('[data-session="p1"] .ss-row')
  await until('普通会话选中', () => one('[data-session="p1"] .ss-row.sel'))
  await click('.tb-side')
  await until('会话侧面板打开', () => one('.tb-side[aria-pressed="true"]'))
  await click('[data-sidebar-mode="manager"]')
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
  await click('[data-board-tab="lines"]')
  await click('[data-sidebar-mode="chat"]')
  const chatRestored = Boolean(
    await until(
      '切回普通会话和侧面板',
      () => one('[data-session="p1"] .ss-row.sel') && one('.tb-side[aria-pressed="true"]'),
    ),
  )
  await click('[data-sidebar-mode="manager"]')
  const managerRestored = Boolean(
    await until(
      '切回原经理与看板页签',
      () =>
        one('[data-manager="session"][data-manager-id="m1"]') &&
        one('[data-board-tab="lines"][aria-selected="true"]'),
    ),
  )
  // 顶栏的全局活动入口走 requestOpenSession，目标普通会话不在经理侧栏里。
  await click('.mach-mark')
  await click('[data-process="mp-1"] .mach-proc-meta button')
  const externalChat = Boolean(
    await until(
      '外部入口打开普通会话并切回对话栏',
      () =>
        one('[data-sidebar-mode="chat"][aria-pressed="true"]') &&
        one('[data-session="b3"] .ss-row.sel'),
    ),
  )
  await click('[data-sidebar-mode="manager"]')
  const externalKeepsManager = Boolean(
    await until(
      '外部跳转后仍恢复原经理和页签',
      () =>
        one('[data-manager="session"][data-manager-id="m1"]') &&
        one('[data-board-tab="lines"][aria-selected="true"]'),
    ),
  )
  await click('[data-sidebar-mode="chat"]')
  await click('[data-session="p1"] .ss-row')
  await click('[data-sidebar-mode="manager"]')
  await click('[data-act="manager-settings"]')
  await until('经理设置页', () => one('[data-manager="settings"]'))
  await click('[data-sidebar-mode="chat"]')
  await until('设置页切到对话', () => one('[data-session="p1"] .ss-row.sel'))
  await click('[data-sidebar-mode="manager"]')
  const settingsRestored = Boolean(
    await until('恢复经理设置页', () => one('[data-manager="settings"]')),
  )
  await click('[data-manager="settings"] .arch-head button')
  await click('[data-board-tab="overview"]')
  // 窄窗口中先切到看板；宽窗口同一组按钮不显示，不需要点。
  const narrow = one<HTMLButtonElement>('.mg-narrow button:last-child')
  if (narrow && narrow.getBoundingClientRect().height > 0) narrow.click()
  await until('概览事项', () => one('[data-overview="blocked"] .mg-item'))
  const overviewUnique =
    document.querySelectorAll('[data-manager-item="I-4"]').length === 1 &&
    !one('[data-overview="yours"] [data-manager-item="I-4"]') &&
    !one('.mg-item > .pill')
  const openingBody = await eventBody('manager-open')
  const opening =
    Boolean(openingBody.textContent?.includes('请负责「Litch 0.23」')) &&
    !one('.mg-chat')?.textContent?.includes('占位回答')
  let eventsClean = cleanChat()
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
  const answerEvent = Boolean((await eventBody('manager-answers')).textContent?.includes('D-15'))
  eventsClean = cleanChat() && eventsClean
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
  const selectedLine = one('.mg-tree .ss-row.sel')
    ?.closest('[data-session]')
    ?.getAttribute('data-session')
  await click('[data-sidebar-mode="chat"]')
  await until('工作线切回对话', () => one('[data-session="p1"] .ss-row.sel'))
  await click('[data-sidebar-mode="manager"]')
  const lineRestored = Boolean(
    await until(
      '恢复经理工作线',
      () =>
        one('.mg-origin') &&
        selectedLine &&
        one(`.mg-tree [data-session="${CSS.escape(selectedLine)}"] .ss-row.sel`),
    ),
  )
  await click('.mg-origin button')
  const childReturn = Boolean(
    await until('回到经理', () => one('[data-manager="session"][data-manager-id="m1"]')),
  )
  const childIds = [...document.querySelectorAll('.mg-tree [data-session]')]
    .map((row) => row.getAttribute('data-session'))
    .filter(Boolean)
  // 经理工作线沿用普通会话行的用户回报开关，切栏后设置和标记仍在。
  const childRow = `.mg-tree [data-session="${CSS.escape(childIds[0] ?? '')}"]`
  await click(`${childRow} [aria-haspopup="menu"]`)
  await click('[data-action="report"]')
  const reportsStopped = Boolean(
    await until('经理子会话停报标记', () => one(`${childRow} [data-report="off"]`)),
  )
  one<HTMLButtonElement>('[data-sidebar-mode="chat"]')?.click()
  await until('返回普通对话', () => !one('.mg-sidebar-manager'))
  const isolated =
    childIds.length > 0 &&
    childIds.every(
      (id) => !document.querySelector(`.sb-scroll [data-session="${CSS.escape(id ?? '')}"]`),
    )
  await click('[data-sidebar-mode="manager"]')
  await until('切栏后保留停报标记', () => one(`${childRow} [data-report="off"]`))
  await click(`${childRow} [aria-haspopup="menu"]`)
  await click('[data-action="report"]')
  const reportsResumed = await until(
    '恢复回报后去掉标记',
    () => !one(`${childRow} [data-report="off"]`),
  )
  await click('.sb-top .new')
  await until('新建经理表单', () => one('[data-manager="form"]'))
  const field = (label: string) =>
    [...document.querySelectorAll<HTMLLabelElement>('.mg-form label')].find(
      (entry) => entry.firstChild?.textContent?.trim() === label,
    )
  if (document.querySelector('.mg-form .mng-sec:first-child select'))
    throw new Error('新建经理仍显示模板选择')
  const nameInput = field('名称')?.querySelector('input')
  const promptInput = field('经理设定')?.querySelector('textarea')
  const cwdInput = field('工作目录')?.querySelector('input')
  const max = field('最大并行工作线数')?.querySelector('input')
  if (!nameInput || !promptInput || !cwdInput || !max) throw new Error('经理表单缺少字段')
  if (one('.mg-rules') || field('范围')) throw new Error('经理表单仍显示范围或自动规则')
  if (one<HTMLInputElement>('.mg-fields input[type="checkbox"]')?.checked)
    throw new Error('新建经理默认启用了工作树')
  fill(nameInput, '经理冒烟验收')
  fill(promptInput, '仅执行冒烟验收范围内的任务。')
  fill(cwdInput, '~/work/litch')
  const look = (
    window as unknown as { __litchLook: { set(patch: { lang: 'zh-CN' | 'en' }): void } }
  ).__litchLook
  look.set({ lang: 'en' })
  const promptLocalized = await until(
    '经理设定英文标签',
    () => Boolean(field('Manager settings')) && promptInput.placeholder.includes('Optional'),
  )
  fill(max, '2')
  const promptKept = await until(
    '修改任务分配和语言保留经理设定',
    () => promptInput.value === '仅执行冒烟验收范围内的任务。' && max.value === '2',
  )
  look.set({ lang: 'zh-CN' })
  await until('恢复中文', () => document.documentElement.lang === 'zh-CN')
  // 空经理设定可以创建，自动规则不由界面填入。
  fill(promptInput, '')
  await click('.mg-form button[type="submit"]')
  const created = await until('建好后进入经理', () =>
    one('.mg-title')?.textContent?.includes('经理冒烟验收'),
  )
  const createdId = one('[data-manager="session"]')?.getAttribute('data-manager-id')
  const createdEvent = Boolean(
    (await eventBody('manager-open')).textContent?.includes('经理冒烟验收'),
  )
  await click('[data-sidebar-mode="chat"]')
  const createdKeepsChat = Boolean(
    await until('新建经理不覆盖原对话', () => one('[data-session="p1"] .ss-row.sel')),
  )
  await click('[data-sidebar-mode="manager"]')
  await until('恢复新建的经理', () =>
    one(`[data-manager="session"][data-manager-id="${createdId}"]`),
  )
  eventsClean = cleanChat() && eventsClean
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
    !field('首个任务') &&
    !field('从哪种开始')
  fill(editField('名称'), '经理设置验收')
  fill(editField('最大并行工作线数'), '0')
  one('.mg-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  const settingsValidation = Boolean(
    await until('无效并发上限显示原因', () => one('.mg-form [role="alert"]')),
  )
  fill(editField('经理设定'), '修改后的经理设定\n\n保留验收记录。')
  fill(editField('最大并行工作线数'), '5')
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
  await select('合并方式', 'user')
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    '.mg-fields input[type="checkbox"]',
  ))
    checkbox.click()
  const settingsKept = await until(
    '编辑任务分配保留经理设定',
    () => editField('经理设定').value === '修改后的经理设定\n\n保留验收记录。',
  )
  await click('.mg-form button[type="submit"]')
  const settingsSaved = await until(
    '更新名称、经理设定和事件',
    () =>
      one('.mg-title')?.textContent?.includes('经理设置验收') &&
      one('.crumb')?.textContent?.includes('经理设置验收') &&
      one(`.mg-sidebar-manager[data-manager-id="${createdId}"] .mg-pick`)?.textContent?.includes(
        '经理设置验收',
      ) &&
      one('.mg-scope')?.textContent?.includes('修改后的经理设定') &&
      Boolean(one('[data-event="manager-rules"]')),
  )
  const rulesBody = await eventBody('manager-rules')
  const rulesEvent =
    rulesBody.children.length === 2 &&
    rulesBody.children[0]?.textContent === '修改后的经理设定' &&
    rulesBody.children[1]?.textContent === '保留验收记录。'
  eventsClean = cleanChat() && eventsClean
  await click('[data-act="manager-settings"]')
  await until('重新打开保存的并发上限', () => editField('最大并行工作线数').value === '5')
  const dispatchSaved =
    field('子会话模型')?.querySelector('select')?.value === lineModel &&
    field('合并方式')?.querySelector('select')?.value === 'user' &&
    [...document.querySelectorAll<HTMLInputElement>('.mg-fields input[type="checkbox"]')].every(
      (input, index) => input.checked === (index === 0),
    )
  fill(editField('经理设定'), '取消的修改不应保存')
  await click('.mg-form-foot button[type="button"]')
  const settingsCancelled = await until('取消不保存', () =>
    one('.mg-scope')?.textContent?.includes('修改后的经理设定'),
  )
  await click('.mg-sidebar-group header .ibtn')
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
  eventsClean = cleanChat() && eventsClean
  await click('.mg-sidebar-group header .ibtn')
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
  const endEvent = Boolean(
    (await eventBody('manager-end')).textContent?.includes('请整理总结，保留未完成事项。'),
  )
  eventsClean = cleanChat() && eventsClean
  await click('[data-sidebar-mode="chat"]')
  await click('[data-session="p1"] [aria-haspopup="menu"]')
  await click('[data-action="archive"]')
  await until('已归档的会话从目录移除', () => !one('[data-session="p1"]'))
  await click('[data-sidebar-mode="manager"]')
  await until('归档普通会话不影响经理', () => one('[data-manager="session"][data-manager-id="m1"]'))
  await click('[data-sidebar-mode="chat"]')
  const archivedFallback = Boolean(await until('切回对话默认页', () => one('.new-page')))
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
    reportsStopped,
    reportsResumed,
    created,
    promptKept,
    endedReadOnly,
    endingReadOnly,
    endingListed,
    endCompleted,
    answerEvent,
    createdEvent,
    rulesEvent,
    endEvent,
    eventsClean,
    omittedActions,
    itemReasons,
    decisionJump,
    overviewUnique,
    opening,
    promptLocalized,
    endedRow,
    branchFacts,
    settingsSaved,
    settingsKept,
    settingsCancelled,
    settingsReadOnly,
    settingsValidation,
    dispatchSaved,
    chatRestored,
    managerRestored,
    lineRestored,
    settingsRestored,
    createdKeepsChat,
    archivedFallback,
    externalChat,
    externalKeepsManager,
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
    reportsStopped: '经理子会话停止回报后没有显示标记',
    reportsResumed: '经理子会话恢复回报后标记没有移除',
    created: '新建经理没有进入经理页',
    promptKept: '经理设定被任务分配选项覆盖',
    endedReadOnly: '已结束经理没有转只读',
    endingReadOnly: '结束中经理未标明状态或仍能写入',
    endingListed: '结束中经理未保留在全部经理列表',
    endCompleted: '收尾回合结束后经理未转已结束只读',
    answerEvent: '看板答复回合没有显示经理事件',
    createdEvent: '新建经理的默认开场没有显示事件卡',
    rulesEvent: '更新规则后没有显示事件卡或正文没有按空行分段',
    endEvent: '结束经理后没有显示收尾事件卡',
    eventsClean: '经理对话中出现了原始 litch-session-event 标签',
    omittedActions: '仍显示第一版不支持的操作',
    itemReasons: '事项原因重复决策编号或状态标签',
    decisionJump: '点击决策编号没有切页并定位',
    overviewUnique: '卡住的用户事项在概览重复出现',
    opening: '经理对话仍使用 id 或占位回答开场',
    promptLocalized: '经理设定标签和占位提示没有跟随界面语言',
    endedRow: '已结束经理有无效占位或总结按钮错位',
    branchFacts: '工作线仍显示孤立的未知',
    settingsSaved: '设置保存后名称、经理设定或事件未更新',
    settingsKept: '编辑经理时原有设定被选项覆盖',
    settingsCancelled: '取消设置仍保存了修改',
    settingsReadOnly: '编辑经理仍能修改设备、目录或经理自身运行配置',
    settingsValidation: '无效设置没有显示原因并保留表单',
    dispatchSaved: '子会话模型、工作树、合并方式或通知设置没有保存',
    chatRestored: '切回对话后原会话或侧面板丢失',
    managerRestored: '切回经理后原经理或看板页签丢失',
    lineRestored: '切回经理后原工作线丢失',
    settingsRestored: '切回经理后设置页丢失',
    createdKeepsChat: '新建经理覆盖了对话视图的位置',
    archivedFallback: '已归档会话在切回对话后仍被恢复',
    externalChat: '经理视图从外部打开普通会话后未切到对话栏',
    externalKeepsManager: '外部跳转到普通会话后丢失了经理位置',
  }
  return (Object.keys(messages) as (keyof ManagerSeen)[])
    .filter((key) => !seen[key])
    .map((key) => messages[key])
}
