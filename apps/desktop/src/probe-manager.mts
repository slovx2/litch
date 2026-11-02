// 经理冒烟只操作正式界面，模拟核心负责写答案和生成答复回合。
export interface ManagerSeen {
  linesState: boolean
  /** 经理行和普通对话的父子树同一套：默认收起、下面一行“› N 个子会话”，点开展开；行高、记号缩进与工作线行一致 */
  treeShape: boolean
  treeShapeDetail: string
  pendingTitle: boolean
  answeredSplit: boolean
  issueOrder: boolean
  previousClosed: boolean
  /** 经理重开用户忽略过的决策：默认展开显示经理写的理由（上次关闭仍收起） */
  managerReopened: boolean
  /** 忽略：填选填理由确认，离开待定、不计待处理，单独一组显示理由；撤销忽略回到待定 */
  ignored: boolean
  ignoreDetail: string
  /** 决策在别处不再待定（这里用忽略）后草稿不计数、卡片提示可查看与丢弃；撤销后草稿自动恢复可提交 */
  endedDraft: boolean
  endedDraftDetail: string
  consoleReports: boolean
  issueRelations: boolean
  managerQuestionDrafts: boolean
  userRequests: boolean
  backgroundQuestions: boolean
  questionForwarded: boolean
  revisedAnswer: boolean
  list: boolean
  selected: boolean
  pendingTooltip: boolean
  draft: boolean
  submitted: boolean
  submitKeepsPending: boolean
  batchKeepsPending: boolean
  turnAdded: boolean
  isolated: boolean
  draftKept: boolean
  reopened: boolean
  panels: boolean
  childReturn: boolean
  reportsStopped: boolean
  reportsResumed: boolean
  created: boolean
  creationRemembered: boolean
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
  /**
   * 比应用旧的设备服务（本机在跑旧版）：控制台顶上写明哪些不可用、去设备详情升级；忽略、追问、
   * 请你做的交付与回复、报告已阅禁用并写原因；决策答复照常能交
   */
  oldDevice: boolean
  oldDeviceDetail: string
}

export async function managerProbe(captureQuestions = false): Promise<ManagerSeen> {
  const one = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)
  const click = async (selector: string) => {
    const category = selector.match(
      /^\[data-board-tab="(decisions|suggestions|requests|reports)"\]$/,
    )
    if (category && !one(selector)) {
      ;(await until('控制台', () => one<HTMLButtonElement>('[data-board-tab="inbox"]'))).click()
    }
    return until(selector, () => one<HTMLButtonElement>(selector)).then((button) => button.click())
  }
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
        permission: one('.mg-form [data-kind="permission"]')?.textContent,
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
  await click('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *)')
  await until('普通会话选中', () =>
    one('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *).sel'),
  )
  await click('.tb-side')
  await until('会话侧面板打开', () => one('.tb-side[aria-pressed="true"]'))
  await click('[data-sidebar-mode="manager"]')
  const list = Boolean(await until('全部经理页', () => one('[data-manager="list"]')))
  // 列表页先出来，经理那几行是随后到的：等已结束的那一行和它的总结按钮都在了再量
  const ended = await until('已结束的经理那一行', () =>
    one('[data-manager-row="e1"] .mg-list-open'),
  )
  const summary = await until('已结束经理的总结按钮', () =>
    one('[data-manager-row="e1"] > button.btn'),
  )
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
  await click('[data-act="manager-board-toggle"]')
  const boardToggle = await until('看板收起入口', () =>
    one<HTMLButtonElement>('[data-act="manager-board-toggle"][aria-expanded="false"]'),
  )
  const pendingTooltip = Boolean(
    boardToggle.title === '3 个决策 · 1 个请你做' &&
      one('[data-act="manager-board-toggle"] .pill')?.textContent === '4 待处理' &&
      boardToggle.title === one('[data-act="manager-board-toggle"] .pill')?.getAttribute('title'),
  )
  await click('[data-act="manager-board-toggle"]')
  await click('[data-board-tab="suggestions"]')
  await click('[data-sidebar-mode="chat"]')
  const chatRestored = Boolean(
    await until(
      '切回普通会话和侧面板',
      () =>
        one('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *).sel') &&
        one('.tb-side[aria-pressed="true"]'),
    ),
  )
  await click('[data-sidebar-mode="manager"]')
  const managerRestored = Boolean(
    await until(
      '切回原经理与看板页签',
      () =>
        one('[data-manager="session"][data-manager-id="m1"]') &&
        one('[data-board-tab="suggestions"][aria-pressed="true"]'),
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
        one('[data-session="b3"]:not(.projection-group *) .ss-row:not(.projection-group *).sel'),
    ),
  )
  await click('[data-sidebar-mode="manager"]')
  const externalKeepsManager = Boolean(
    await until(
      '外部跳转后仍恢复原经理和页签',
      () =>
        one('[data-manager="session"][data-manager-id="m1"]') &&
        one('[data-board-tab="suggestions"][aria-pressed="true"]'),
    ),
  )
  await click('[data-sidebar-mode="chat"]')
  await click('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *)')
  await click('[data-sidebar-mode="manager"]')
  await click('[data-act="manager-settings"]')
  await until('经理设置页', () => one('[data-manager="settings"]'))
  await click('[data-sidebar-mode="chat"]')
  await until('设置页切到对话', () =>
    one('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *).sel'),
  )
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
      one('[data-board-tab="decisions"]')?.getAttribute('aria-pressed') === 'true',
  )
  ;(await until('决策页签', () => one<HTMLButtonElement>('[data-board-tab="decisions"]'))).click()
  await click('[data-decision="D-15"] [data-act="post-ask"]')
  await click('[data-decision="D-15"] [data-question-mode="temporary"]')
  const askBackground = async (value: string, count: number) => {
    if (!one('[data-decision="D-15"] .mg-post-discussion textarea'))
      await click('[data-decision="D-15"] [data-act="post-ask"]')
    const input = await until('背景问题输入框', () =>
      one<HTMLTextAreaElement>('[data-decision="D-15"] .mg-post-discussion textarea'),
    )
    fill(input, value)
    await until(
      '背景提问按钮可用',
      () =>
        !one<HTMLButtonElement>('[data-decision="D-15"] [data-act="post-question-send"]')?.disabled,
    )
    await click('[data-decision="D-15"] [data-act="post-question-send"]')
    await until(
      '背景问答完成',
      () =>
        document.querySelectorAll('[data-decision="D-15"] .mg-post-timeline li').length ===
        count * 2,
    )
  }
  const turnsBeforeQuestions = document.querySelectorAll('.mg-chat .turn').length
  await askBackground('为什么推荐这个选项？', 1)
  await askBackground('还有哪些影响需要确认？', 2)
  if (captureQuestions) {
    one('[data-decision="D-15"] .mg-post-discussion')?.scrollIntoView({ block: 'center' })
    await new Promise<void>((resolve) => {
      window.addEventListener('litch-manager-questions-captured', () => resolve(), { once: true })
      document.documentElement.dataset.managerQuestionsReady = 'true'
    })
  }
  const backgroundQuestions =
    document.querySelectorAll('.mg-chat .turn').length === turnsBeforeQuestions
  await click('[data-decision="D-15"] [data-act="manager-question-forward"]')
  const questionForwarded = Boolean(
    await until('问答已转给经理', () =>
      one('[data-act="manager-question-forward"]')?.textContent?.includes('已转给经理'),
    ),
  )

  ;(
    await until('按推荐', () =>
      one<HTMLButtonElement>('[data-decision="D-15"] [data-act="manager-recommend"]'),
    )
  ).click()
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
  // 不数回合：刚切回这位经理时回合列表延后取，旧回合又分批补画在前面，数目会自己涨。
  // 认提交前最后那个回合后面新出的回合里有答复的事件卡（补画的旧回合都在它前面）
  const chatTurns = () => [...document.querySelectorAll<HTMLElement>('.mg-chat .turn')]
  const lastBefore = chatTurns().at(-1)?.dataset.searchTurn ?? ''
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
  const submitKeepsPending = Boolean(
    one('[data-filter="open"][aria-pressed="true"]') &&
      !one('[data-decision="D-15"]') &&
      document.activeElement === one('.mg-decision-filter'),
  )
  const turnAdded = await until('对话新增一回合', () => {
    const turns = chatTurns()
    return turns
      .slice(turns.findIndex((entry) => entry.dataset.searchTurn === lastBefore) + 1)
      .some((entry) => entry.querySelector('[data-event="manager-answers"]'))
  })
  const answerEvent = Boolean((await eventBody('manager-answers')).textContent?.includes('D-15'))
  eventsClean = cleanChat() && eventsClean
  await click('.mg-decision-filter [data-filter="answered"]')
  await click('[data-decision="D-15"] [data-act="manager-edit-answer"]')
  fill(
    await until('修改答案输入框', () =>
      one<HTMLTextAreaElement>('[data-decision="D-15"] [data-act="manager-answer"]'),
    ),
    '修改后的答案：先核对影响',
  )
  await until(
    '修改答案可提交',
    () => !one<HTMLButtonElement>('[data-act="manager-submit"]')?.disabled,
  )
  await click('[data-act="manager-submit"]')
  const revisedAnswer = Boolean(
    await until(
      '修改答案写回',
      () =>
        !one('.mg-send') &&
        one('[data-filter="answered"][aria-pressed="true"]') &&
        one('[data-decision="D-15"]')?.textContent?.includes('修改后的答案'),
    ),
  )
  if (!one('[data-decision="D-15"] [data-act="manager-question-input"]'))
    await click('[data-decision="D-15"] [data-act="post-ask"]')
  await click('[data-decision="D-15"] [data-question-mode="manager"]')
  fill(
    await until('经理追问草稿', () =>
      one<HTMLTextAreaElement>('[data-decision="D-15"] [data-act="manager-question-input"]'),
    ),
    '请补充影响范围',
  )
  await click('[data-board-tab="requests"]')
  fill(
    await until('请你做备注', () =>
      one<HTMLTextAreaElement>('[data-manager-request="R-1"] [data-act="manager-request-text"]'),
    ),
    '真机已复验',
  )
  await click('[data-manager-request="R-1"] [data-act="post-ask"]')
  fill(
    await until('交付与追问同批草稿', () =>
      one<HTMLTextAreaElement>('[data-manager-request="R-1"] [data-act="manager-question-input"]'),
    ),
    '交付后还需哪些验证？',
  )
  await click('[data-manager-request="R-1"] [data-act="manager-request-deliver"]')
  await click('[data-act="manager-submit"]')
  const userRequests = Boolean(
    await until(
      '交付写回请你做',
      () =>
        !one('.mg-send') &&
        one('[data-manager-request="R-1"]')?.textContent?.includes('真机已复验') &&
        one('[data-manager-request="R-1"] .mg-post-timeline')?.textContent?.includes(
          '交付后还需哪些验证',
        ),
    ),
  )
  await click('[data-board-tab="decisions"]')
  const managerQuestionDrafts = Boolean(
    await until(
      '经理回复写回记录',
      () =>
        one('[data-decision="D-15"] .mg-post-timeline')?.textContent?.includes('请补充影响范围') &&
        one('[data-decision="D-15"] .mg-post-timeline')?.textContent?.includes('经理回复'),
    ),
  )

  // 已答复：答复单独一块（选中项与文字），其他选项默认收起；排序默认最新优先，切换后记在本机。
  await click('.mg-decision-filter button:nth-child(2)')
  const d13 = await until('已答复的决策', () => one('[data-decision="D-13"]'))
  const answer = d13.querySelector('.mg-answer[data-answer="current"]')
  const others = d13.querySelector<HTMLDetailsElement>('details[data-other-options]')
  const answeredSplit = Boolean(
    answer?.querySelector('[data-option="b"]') &&
      answer.textContent?.includes('你的答复') &&
      answer.textContent.includes('子会话已有回报') &&
      !answer.textContent.includes('后台任务页要列出') &&
      others &&
      !others.open &&
      others.querySelector('summary')?.textContent?.includes('其他选项 2') &&
      others.querySelectorAll('[data-option]').length === 2 &&
      !others.querySelector('[data-option="b"]') &&
      one('[data-decision="D-11"] .mg-answer')?.textContent?.includes('你在对话中的答复'),
  )
  const answeredOrder = () =>
    [...document.querySelectorAll('.mg-stack > .mg-decision')]
      .map((card) => card.getAttribute('data-decision'))
      .join(',')
  const orderSelect = await until('排序选择', () =>
    one<HTMLSelectElement>('.mg-decision-filter [data-act="manager-issue-order"]'),
  )
  // 决策已按状态分开，排序在状态切换那一行，不给“待处理优先”
  const decisionChoices = [...orderSelect.options].map((option) => option.value).join(',')
  const newestFirst =
    decisionChoices === 'newest,oldest' &&
    orderSelect.value === 'newest' &&
    answeredOrder() === 'D-15,D-13,D-11'
  const choose = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
      orderSelect,
      value,
    )
    orderSelect.dispatchEvent(new Event('change', { bubbles: true }))
  }
  choose('oldest')
  const oldestFirst = Boolean(await until('最早优先', () => answeredOrder() === 'D-11,D-13,D-15'))
  const orderSaved = localStorage.getItem('litch.managerIssueOrder') === 'oldest'
  choose('newest')
  await until('恢复最新优先', () => answeredOrder() === 'D-15,D-13,D-11')
  const issueOrder = newestFirst && oldestFirst && orderSaved

  await click('.mg-decision-filter [data-filter="closed"]')
  await until('已关闭的决策', () => one('[data-decision="D-12"]'))
  const closedSplit = Boolean(
    one('[data-decision="D-12"] .mg-closed-note')?.textContent?.includes('已关闭 · 经理') &&
      one('[data-decision="D-12"] .mg-closed-note')?.textContent?.includes('feat/mobile-mermaid'),
  )
  const closedNeedsReopen = !one('[data-decision="D-12"] [data-act="manager-edit-answer"]')
  await click('[data-decision="D-12"] [data-act="manager-reopen"]')
  const reopened = Boolean(
    closedNeedsReopen &&
      (await until('决策重新打开', () => one('[data-decision="D-12"] textarea'))),
  )
  // 重新打开后，上次关闭的原因作历史留着，默认收起
  const history = one<HTMLDetailsElement>('[data-decision="D-12"] [data-previous-closed]')
  const previousClosed = Boolean(
    history &&
      !history.open &&
      history.querySelector('summary')?.textContent?.includes('上次关闭 · 经理') &&
      getComputedStyle(history.querySelector('summary') as Element, '::before').content === '"▸"' &&
      history.textContent?.includes('feat/mobile-mermaid'),
  )
  const reopenedNote = one<HTMLDetailsElement>('[data-decision="D-16"] [data-reopened]')
  const managerReopened = Boolean(
    reopenedNote &&
      reopenedNote.open &&
      reopenedNote.querySelector('summary')?.textContent?.includes('经理重新打开') &&
      reopenedNote.textContent?.includes('song-pc'),
  )

  // 忽略 D-17：选填理由，确认后离开待定、不计待处理；在“已忽略”里看得到理由，撤销忽略回到待定
  const count = (key: string) =>
    Number.parseInt(
      one(`.mg-decision-filter [data-filter="${key}"]`)?.textContent?.replace(/\D+/g, ' ').trim() ??
        '',
      10,
    )
  // 收件箱“决策”页签上的待处理数（设备给的 pendingDecisions）
  const decisionPill = () =>
    Number.parseInt(one('[data-board-tab="decisions"] .pill')?.textContent ?? '0', 10)
  const openBefore = count('open')
  const ignoredBefore = count('ignored')
  const pillBefore = decisionPill()
  await click('[data-decision="D-17"] [data-act="manager-ignore"]')
  fill(
    await until('忽略理由', () =>
      one<HTMLTextAreaElement>('[data-decision="D-17"] [data-act="manager-ignore-reason"]'),
    ),
    '网关不归这个项目管',
  )
  const ignoreNote = one('[data-decision="D-17"] [data-ignore-form]')?.textContent ?? ''
  await click('[data-decision="D-17"] [data-act="manager-ignore-confirm"]')
  await until(
    '忽略后离开待定',
    () => !one('[data-decision="D-17"]') && count('ignored') === ignoredBefore + 1,
  )
  // 待处理数随经理对象的通知更新，等它跟上；跟不上的照实记进下面的明细
  await until('决策待处理数减一', () => decisionPill() === pillBefore - 1).catch(() => null)
  const ignoredCounts = `${openBefore}->${count('open')} ${ignoredBefore}->${count('ignored')} 决策待处理 ${pillBefore}->${decisionPill()}`
  await click('.mg-decision-filter [data-filter="ignored"]')
  const ignoredCard = await until('已忽略的 D-17', () =>
    one('[data-decision="D-17"] [data-ignored]'),
  )
  const ignoredText = ignoredCard.textContent ?? ''
  await click('[data-decision="D-17"] [data-act="manager-unignore"]')
  const unignored = Boolean(
    await until(
      '撤销忽略回到待定',
      () =>
        one('.mg-decision-filter [data-filter="open"][aria-pressed="true"]') &&
        one('[data-decision="D-17"] [data-act="manager-ignore"]') &&
        count('open') === openBefore,
    ),
  )
  const ignored =
    ignoreNote.includes('经理会收到通知') &&
    count('open') === openBefore &&
    ignoredCounts ===
      `${openBefore}->${openBefore - 1} ${ignoredBefore}->${ignoredBefore + 1} 决策待处理 ${pillBefore}->${pillBefore - 1}` &&
    ignoredText.includes('你已忽略') &&
    ignoredText.includes('网关不归这个项目管') &&
    unignored &&
    !one('[data-decision="D-17"] [data-previous-closed]')
  const ignoreDetail = JSON.stringify({ ignoreNote, ignoredCounts, ignoredText, unignored })

  // 有草稿的 D-17 被忽略（等同在别处答复或关闭）：底部和侧栏都不再算它，提交栏消失；忽略的卡片上说明草稿还在，
  // 可查看、可丢弃。撤销忽略后草稿自动回来、能直接提交（不要求先确认）；丢弃后撤销则什么都不剩。
  const sideDrafts = () => one('[data-manager-draft-count]')?.textContent?.trim() ?? ''
  const sendBar = () => one('.mg-send .grow')?.textContent?.trim() ?? ''
  const draftArea = () =>
    one<HTMLTextAreaElement>('[data-decision="D-17"] [data-act="manager-answer"]')
  const hadBar = sendBar()
  fill(await until('D-17 的答复框', draftArea), '先放着的草稿')
  await until('草稿进了提交栏', () => sendBar() && sendBar() !== hadBar)
  const withDraft = { bar: sendBar(), side: sideDrafts() }
  const ignoreD17 = async () => {
    await click('[data-decision="D-17"] [data-act="manager-ignore"]')
    await click('[data-decision="D-17"] [data-act="manager-ignore-confirm"]')
    await until('D-17 离开待定', () => !one('[data-decision="D-17"]'))
    await click('.mg-decision-filter [data-filter="ignored"]')
    return until('忽略卡片上的草稿说明', () => one('[data-decision="D-17"] [data-draft-ended]'))
  }
  const note = await ignoreD17()
  const endedCounts = { bar: sendBar(), side: sideDrafts() }
  const noteText = note.textContent ?? ''
  // 先是“你已忽略”的记录，再是草稿说明
  const ignoredRecord = one('[data-decision="D-17"] [data-ignored]')
  const recordFirst = Boolean(
    ignoredRecord && ignoredRecord.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
  await click('[data-decision="D-17"] [data-act="manager-draft-view"]')
  const preview = (
    await until('查看草稿', () => one('[data-decision="D-17"] [data-draft-preview]'))
  ).textContent
  const formHidden = !one('[data-decision="D-17"] [data-act="manager-answer"]')
  await click('[data-decision="D-17"] [data-act="manager-unignore"]')
  const revived = Boolean(
    await until(
      '撤销忽略后草稿回来',
      () =>
        draftArea()?.value === '先放着的草稿' &&
        sendBar() === withDraft.bar &&
        !one('[data-decision="D-17"] .mg-conflict') &&
        !one<HTMLButtonElement>('[data-act="manager-submit"]')?.disabled,
    ).catch(() => null),
  )
  const revivedSide = sideDrafts()
  await ignoreD17()
  await click('[data-decision="D-17"] [data-act="manager-draft-discard"]')
  // 丢弃要再确认一次，写明不能恢复；确认前草稿还在
  const discardAsk =
    (
      await until('丢弃的确认', () => one('[data-decision="D-17"] [data-draft-discard]'))
    ).textContent?.includes('丢弃后不能恢复') === true &&
    Boolean(one('[data-decision="D-17"] [data-draft-ended]'))
  await click('[data-decision="D-17"] [data-act="manager-draft-discard-confirm"]')
  await until('丢弃后说明消失', () => !one('[data-decision="D-17"] [data-draft-ended]'))
  await click('[data-decision="D-17"] [data-act="manager-unignore"]')
  const discarded = Boolean(
    await until('丢弃后撤销忽略', () => draftArea()?.value === '' && sendBar() === hadBar).catch(
      () => null,
    ),
  )
  const endedDraft =
    !hadBar &&
    withDraft.bar === '1 项草稿，尚未提交' &&
    withDraft.side === '1 项草稿' &&
    endedCounts.bar === '' &&
    endedCounts.side === '' &&
    noteText.includes('已忽略') &&
    noteText.includes('草稿还在') &&
    Boolean(preview?.includes('先放着的草稿')) &&
    formHidden &&
    recordFirst &&
    discardAsk &&
    revived &&
    revivedSide === '1 项草稿' &&
    discarded
  const endedDraftDetail = JSON.stringify({
    hadBar,
    withDraft,
    endedCounts,
    noteText,
    preview,
    formHidden,
    recordFirst,
    discardAsk,
    revived,
    revivedSide,
    discarded,
  })
  const omittedActions = ![...document.querySelectorAll('.mg-board button')].some((button) =>
    /^(仍然有效|推迟)$/.test(button.textContent?.trim() ?? ''),
  )
  await click('[data-board-tab="reports"]')
  await until('报告原帖', () => one('[data-report="P-1"]'))
  // 其他类别的排序在一行细的列表头里，三项都有
  const listOrder = one<HTMLSelectElement>('.mg-list-head [data-act="manager-issue-order"]')
  const orderInHead = Boolean(
    listOrder &&
      [...listOrder.options].map((option) => option.value).join(',') === 'newest,oldest,pending' &&
      !one('.mg-inbox-bar [data-act="manager-issue-order"]'),
  )
  const issueRelations = Boolean(
    one('[data-report="P-1"] [data-relations="P-1"] [data-relation-target="D-15"]') &&
      one('[data-report="P-1"] [data-board-reference="I-2"]'),
  )
  const attentionBeforeRead = one('[data-board-tab="inbox"] .pill')?.textContent
  const unreadBadgeBeforeRead = one('[data-board-tab="reports"] .pill')?.textContent === '1'
  await click('[data-act="report-read"]')
  await until('报告已阅', () => !one('[data-act="report-read"]'))
  await click('[data-report="P-1"] [data-act="post-ask"]')
  fill(
    await until('报告追问框', () => one<HTMLTextAreaElement>('[data-report="P-1"] textarea')),
    '报告还有什么限制？',
  )
  await click('[data-report="P-1"] [data-act="post-question-send"]')
  const consoleReports = Boolean(
    unreadBadgeBeforeRead &&
      !one('[data-board-tab="reports"] .pill') &&
      attentionBeforeRead === one('[data-board-tab="inbox"] .pill')?.textContent &&
      (await until('报告帖子记录', () =>
        one('[data-report="P-1"] .mg-post-timeline')?.textContent?.includes('报告还有什么限制'),
      )),
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
      !one('[data-decision="D-15"] [data-act="manager-answer"]'),
  )
  await click('[data-board-tab="suggestions"]')
  const panels =
    !one('[data-board-tab="lines"]') &&
    !one('[data-overview="yours"]') &&
    Boolean(one('[data-board-tab="suggestions"]'))
  // 经理一节的树：经理行默认收起，下面只有“› N 个子会话”，点开后工作线挂在下面（和普通对话的父子树同一套）。
  // m1 前面选中过它的工作线，已经展开：先收起再量；“默认收起”看没碰过的 m3
  const m1 = '.mg-sidebar-manager[data-manager-id="m1"]'
  const caret = () => one(`${m1} .row-line > .tree-fold`)?.getAttribute('aria-expanded') ?? ''
  const untouched = Boolean(one('.mg-sidebar-manager[data-manager-id="m3"] .tree-kids > .tree-sum'))
  if (caret() === 'true') await click(`${m1} .row-line > .tree-fold`)
  await until('收起经理工作线', () => one(`${m1} .tree-kids > .tree-sum`))
  const folded = {
    untouched,
    sum: one(`${m1} .tree-kids > .tree-sum`)?.textContent?.trim() ?? '',
    caret: caret(),
    hidden: !one(`${m1} .mg-tree`),
    oldFold: Boolean(one('.mg-fold, .mg-sidebar-children')),
  }
  await click(`${m1} .tree-sum`)
  await until('展开经理工作线', () => one(`${m1} .tree-kids .mg-tree [data-session]`))
  const lineRows = () => [
    ...document.querySelectorAll<HTMLElement>(
      `${m1} .mg-tree [data-depth="1"] > .row-line > .ss-row`,
    ),
  ]
  const box = (e: Element | null | undefined) => e?.getBoundingClientRect()
  const managerRow = () => one(`${m1} .row-line > .ss-row`)
  // 六种外观各量一次：标题、记号都在固定的列里，工作线的标题比经理的靠右，差值等于普通对话父子之间的缩进
  // （.tree-kids 的左内边距，普通对话的子会话也挂在它里面）
  const appearance = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string }
        set(patch: { skin?: string; theme?: string }): void
      }
    }
  ).__litchLook
  const was = appearance.get()
  const columns: Record<string, unknown> = {}
  let columnsOk = true
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark']) {
      appearance.set({ skin, theme })
      await document.fonts.ready
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      const row = box(managerRow())
      const title = box(managerRow()?.querySelector(':scope > .title'))
      const mark = box(managerRow()?.querySelector(':scope > i.st'))
      const lines = lineRows().map((line) => ({
        row: box(line),
        title: box(line.querySelector(':scope > .title')),
        mark: box(line.querySelector(':scope > i.st')),
      }))
      const kids = one(`${m1} .row-line + .tree-kids`)
      const indent = kids ? Number.parseFloat(getComputedStyle(kids).paddingLeft) : Number.NaN
      const round = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10)
      const seen = {
        indent,
        titleShift: lines.map((line) => round((line.title?.left ?? 0) - (title?.left ?? 0))),
        // 标题在行里的起点：经理行和每条工作线一样（记号占同一列，有没有记号都不推标题）
        titleColumn: [round((title?.left ?? 0) - (row?.left ?? 0))].concat(
          lines.map((line) => round((line.title?.left ?? 0) - (line.row?.left ?? 0))),
        ),
        markShift: lines.map((line) => round((line.mark?.left ?? 0) - (mark?.left ?? 0))),
        height: [round(row?.height)].concat(lines.map((line) => round(line.row?.height))),
      }
      columns[`${skin}-${theme}`] = seen
      columnsOk &&=
        lines.length > 0 &&
        indent > 0 &&
        seen.titleShift.every((shift) => shift === indent) &&
        seen.markShift.every((shift) => shift === indent) &&
        seen.titleColumn.every((left) => left === seen.titleColumn[0]) &&
        seen.height.every((height) => height === seen.height[0])
    }
  appearance.set(was)
  const treeShapeSeen = {
    ...folded,
    lines: lineRows().length,
    caretOpen: caret(),
    columns,
  }
  const treeShape =
    treeShapeSeen.untouched &&
    treeShapeSeen.sum === `${treeShapeSeen.lines} 个子会话` &&
    treeShapeSeen.lines > 0 &&
    treeShapeSeen.caret === 'false' &&
    treeShapeSeen.caretOpen === 'true' &&
    treeShapeSeen.hidden &&
    !treeShapeSeen.oldFold &&
    columnsOk
  let treeShapeDetail = JSON.stringify(treeShapeSeen)
  const branchFacts = Boolean(one('.mg-tree [data-session="manager-k1"]:not(.projection-group *)'))
  await click(
    '.mg-tree [data-session="manager-k1"]:not(.projection-group *) .ss-row:not(.projection-group *)',
  )
  await until('子会话来源', () => one('.mg-origin'))
  const selectedLine = one('.mg-tree .ss-row:not(.projection-group *).sel')
    ?.closest('[data-session]:not(.projection-group *)')
    ?.getAttribute('data-session')
  await click('[data-sidebar-mode="chat"]')
  await until('工作线切回对话', () =>
    one('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *).sel'),
  )
  await click('[data-sidebar-mode="manager"]')
  const lineRestored = Boolean(
    await until(
      '恢复经理工作线',
      () =>
        one('.mg-origin') &&
        selectedLine &&
        one(
          `.mg-tree [data-session="${CSS.escape(selectedLine)}"]:not(.projection-group *) .ss-row:not(.projection-group *).sel`,
        ),
    ),
  )
  await click('.mg-origin button')
  const childReturn = Boolean(
    await until('回到经理', () => one('[data-manager="session"][data-manager-id="m1"]')),
  )
  const childIds = [
    ...document.querySelectorAll('.mg-tree [data-session]:not(.projection-group *)'),
  ]
    .map((row) => row.getAttribute('data-session'))
    .filter(Boolean)
  // 经理工作线沿用普通会话行的用户回报开关，切栏后设置和标记仍在。
  const childRow = `.mg-tree [data-session="${CSS.escape(childIds[0] ?? '')}"]`
  await click(`${childRow} [aria-haspopup="menu"]`)
  await click('[data-action="report"]')
  const reportsStopped = Boolean(
    await until('经理子会话停报标记', () => one(`${childRow} [data-report="off"]`)),
  )
  // 经理行和普通对话的顶层行（未读、最近里的主项）左边对齐：行、记号、标题三处同一个横坐标
  const leftOf = (row: Element | null | undefined) =>
    row
      ? [row, row.querySelector(':scope > i.st'), row.querySelector(':scope > .title')].map(
          (e) => Math.round((e?.getBoundingClientRect().left ?? Number.NaN) * 10) / 10,
        )
      : []
  const managerLeft = leftOf(one('.mg-sidebar-manager .row-line > .ss-row'))
  one<HTMLButtonElement>('[data-sidebar-mode="chat"]')?.click()
  await until('返回普通对话', () => !one('.mg-sidebar-manager'))
  const chatLeft = leftOf(
    await until('普通对话的顶层行', () =>
      one('[data-projection] .tree-node[data-depth="0"] > .row-line > .ss-row'),
    ),
  )
  const rootAligned =
    managerLeft.length === 3 && managerLeft.every((left, i) => left === chatLeft[i])
  const isolated =
    childIds.length > 0 &&
    childIds.every(
      // 隔离断言同时检查目录和投影，不能让经理工作线泄漏到任何普通会话入口。
      (id) => !document.querySelector(`.sb-scroll [data-session="${CSS.escape(id ?? '')}"]`),
    )
  await click('[data-sidebar-mode="manager"]')
  // 示例里的 sub2api：经理自己回合已停、挂着后台命令，另有一条工作线在跑。记号是后台记号而不是运行中，文字写明工作线
  const linesRow = await until('只有工作线在跑的经理行', () =>
    [...document.querySelectorAll<HTMLElement>('.mg-sidebar-manager')].find((row) =>
      row.querySelector('.mg-pick')?.textContent?.includes('sub2api'),
    ),
  )
  const linesState =
    !linesRow.querySelector('.mg-pick > i.st.run') &&
    Boolean(linesRow.querySelector('.mg-pick > i.st.bg[data-background="1"]')) &&
    Boolean(
      linesRow.querySelector('[data-manager-state]')?.textContent?.includes('1 条工作线运行中'),
    )
  // 有待处理的经理行：行上只写“N 待处理”，悬停提示第一行补上状态文字
  const pendingBadges = [
    ...document.querySelectorAll<HTMLElement>(
      '.mg-sidebar-manager .mg-sidebar-counts .mg-attention',
    ),
  ].filter((badge) => !badge.hasAttribute('data-manager-draft-count'))
  const pendingTitle =
    pendingBadges.length > 0 &&
    pendingBadges.every((badge) => {
      const [first = ''] = (badge.title ?? '').split('\n')
      const prefix = `${badge.textContent?.trim()} · `
      return (
        first.startsWith(prefix) &&
        /^(运行中|空闲|\d+ 条工作线运行中|\d+ 个后台任务正在运行)$/.test(first.slice(prefix.length))
      )
    })
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
    [...document.querySelectorAll<HTMLLabelElement>('.mg-panel:not([hidden]) label')].find(
      (entry) => entry.firstChild?.textContent?.trim() === label,
    )
  const activeStep = (step: string) => Boolean(one(`.mg-form[data-manager-step="${step}"]`))
  const tab = (step: string) => click(`[data-form-tab="${step}"]`)
  const next = async () => {
    await until('创建参数已就绪', () => {
      const button = one<HTMLButtonElement>('.mg-form button[type="submit"]')
      return button && !button.disabled
    })
    await click('.mg-form button[type="submit"]')
  }
  const input = (label: string) => {
    const target = field(label)?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    )
    if (!target) throw new Error(`缺少当前步骤字段：${label}`)
    return target
  }
  const select = async (label: string, value: string) => {
    const input = field(label)?.querySelector('select')
    if (!input) throw new Error(`缺少设置选项：${label}`)
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const chooseFirst = async (label: string) => {
    const value = await until(
      `${label}选项`,
      () => field(label)?.querySelector('select')?.options[1]?.value,
    )
    await select(label, value)
  }
  const parameterValues = () =>
    [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '#manager-panel-runtime input.req-input, #manager-panel-runtime select, #manager-panel-dispatch input, #manager-panel-dispatch select',
      ),
    ].map((entry) =>
      entry instanceof HTMLInputElement && entry.type === 'checkbox' ? entry.checked : entry.value,
    )
  if (!activeStep('basic') || field('工作目录') || field('最大并行工作线数'))
    throw new Error('基本信息步骤显示了参数设置')
  if (!one<HTMLButtonElement>('[data-form-tab="dispatch"]')?.disabled)
    throw new Error('未完成前序步骤时可以跳到任务分配')
  if (one('.mg-rules') || field('范围')) throw new Error('经理表单仍显示范围或自动规则')
  const labels = [...document.querySelectorAll('.mg-panel:not([hidden]) label')].map((entry) =>
    entry.firstChild?.textContent?.trim(),
  )
  if (labels.join('/') !== '名称/经理设定/首个任务') throw new Error('基本信息字段顺序错误')
  fill(input('名称'), '经理冒烟验收')
  fill(input('经理设定'), '仅执行冒烟验收范围内的任务。')
  fill(input('首个任务'), '保留首个任务草稿')
  const look = (
    window as unknown as { __litchLook: { set(patch: { lang: 'zh-CN' | 'en' }): void } }
  ).__litchLook
  look.set({ lang: 'en' })
  const promptLocalized = await until(
    '经理设定英文标签',
    () =>
      Boolean(field('Manager settings')) &&
      input('Manager settings').getAttribute('placeholder')?.includes('Optional'),
  )
  look.set({ lang: 'zh-CN' })
  await until('恢复中文', () => document.documentElement.lang === 'zh-CN')
  await next()
  await until('进入运行环境', () => activeStep('runtime'))
  const devices = field('设备')?.querySelector('select')
  const firstDevice = devices?.value
  const otherDevice = [...(devices?.options ?? [])].find(
    (entry) => entry.value !== firstDevice,
  )?.value
  if (!firstDevice || !otherDevice) throw new Error('缺少切换设备的夹具')
  await select('设备', otherDevice)
  await select('设备', firstDevice)
  // 视图恢复后可能带入当前会话的项目，先明确改为无项目，再验空目录的校验。
  const workspace = field('项目')?.querySelector('select')
  if (!workspace) throw new Error('运行环境缺少项目选择')
  workspace.value = ''
  workspace.dispatchEvent(new Event('change', { bubbles: true }))
  await until('清除项目预填的目录', () => input('工作目录').value === '')
  await next()
  await until(
    '空工作目录留在运行环境并显示原因',
    () => activeStep('runtime') && one('.mg-form [role="alert"]'),
  )
  fill(input('工作目录'), '~/work/litch')
  // 只对模拟核心：取消不记确认；确认后跨 harness 复用；换目录不带走项目权限。
  const managerHarness = field('经理使用')?.querySelector('select')
  if (!managerHarness) throw new Error('运行环境缺少 harness 选择')
  managerHarness.value = 'claude'
  managerHarness.dispatchEvent(new Event('change', { bubbles: true }))
  const permissionButton = '.mg-form [data-kind="permission"] .pick-btn'
  const permissionIs = (title: string) => one(permissionButton)?.textContent?.includes(title)
  const pickPermission = async (id: string) => {
    await click(permissionButton)
    const selector = `.mg-form [data-kind="permission"] [data-option="${id}"]`
    await until('权限可选择', () => {
      const option = one<HTMLButtonElement>(selector)
      return option && option.getAttribute('aria-disabled') !== 'true'
    })
    await click(selector)
  }
  await until('项目初始权限', () => permissionIs('工作区'))
  await pickPermission(':danger-full-access')
  await until('首次完全访问需要确认', () => one('.mg-form .pick-ask'))
  await click('.mg-form .pick-ask .ghost')
  if (!permissionIs('工作区')) throw new Error('取消确认改变了项目权限')
  await click('.mg-form [data-option=":danger-full-access"]')
  await click('.mg-form .pick-ask .danger')
  await until('确认后记住完全访问', () => permissionIs('完全访问'))
  await pickPermission(':read-only')
  await until('项目默认降低', () => permissionIs('只读'))
  await pickPermission(':danger-full-access')
  await until(
    '再次选择完全访问不重复确认',
    () => permissionIs('完全访问') && !one('.mg-form .pick-ask'),
  )
  managerHarness.value = 'pi'
  managerHarness.dispatchEvent(new Event('change', { bubbles: true }))
  await until('换 harness 沿用项目权限', () => permissionIs('完全访问'))
  managerHarness.value = 'dsh'
  managerHarness.dispatchEvent(new Event('change', { bubbles: true }))
  await pickPermission(':read-only')
  await until('另一 harness 可降低项目默认', () => permissionIs('只读'))
  await pickPermission(':danger-full-access')
  await until(
    '跨 harness 的确认记录复用',
    () => permissionIs('完全访问') && !one('.mg-form .pick-ask'),
  )
  managerHarness.value = 'claude'
  managerHarness.dispatchEvent(new Event('change', { bubbles: true }))
  fill(input('工作目录'), '~/work/other-project')
  await until('不同项目不继承确认和默认', () => permissionIs('工作区'))
  fill(input('工作目录'), '~/work/litch')
  await until('回到原项目恢复权限', () => permissionIs('完全访问'))
  await next()
  await until('进入任务分配', () => activeStep('dispatch'))
  if (one<HTMLInputElement>('.mg-panel:not([hidden]) input[type="checkbox"]')?.checked)
    throw new Error('新建经理默认启用了工作树')
  fill(input('最大并行工作线数'), '0')
  await next()
  await until(
    '并发数无效时留在任务分配',
    () => activeStep('dispatch') && one('.mg-form [role="alert"]'),
  )
  fill(input('最大并行工作线数'), '2')
  await click('[data-act="manager-previous"]')
  await until(
    '上一步保留运行环境',
    () => activeStep('runtime') && input('工作目录').value === '~/work/litch',
  )
  await tab('basic')
  const promptKept = await until(
    '回到基本信息保留所有文本',
    () =>
      activeStep('basic') &&
      input('名称').value === '经理冒烟验收' &&
      input('经理设定').value === '仅执行冒烟验收范围内的任务。' &&
      input('首个任务').value === '保留首个任务草稿',
  )
  // 首个任务留空仍可创建；经理规则与运行参数要在下次新建时预填。
  fill(input('经理设定'), '记住的经理规则')
  fill(input('首个任务'), '')
  await next()
  await until('再次进入运行环境', () => activeStep('runtime'))
  await chooseFirst('模型')
  await chooseFirst('强度')
  await next()
  await until(
    '再次进入任务分配',
    () => activeStep('dispatch') && input('最大并行工作线数').value === '2',
  )
  await select('子会话使用', 'pi')
  await chooseFirst('子会话模型')
  await chooseFirst('子会话强度')
  await select('合并方式', 'user')
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    '.mg-fields input[type="checkbox"]',
  ))
    checkbox.click()
  const rememberedParameters = parameterValues()
  await next()
  const created = await until('建好后进入经理', () =>
    one('.mg-title')?.textContent?.includes('经理冒烟验收'),
  )
  const createdId = one('[data-manager="session"]')?.getAttribute('data-manager-id')
  const createdEvent = Boolean(
    (await eventBody('manager-open')).textContent?.includes('经理冒烟验收'),
  )
  await click('.sb-top .new')
  await until('再次新建经理', () => one('[data-manager-mode="create"]'))
  const creationRemembered = Boolean(
    input('名称').value === '' &&
      input('首个任务').value === '' &&
      input('经理设定').value === '记住的经理规则' &&
      JSON.stringify(parameterValues()) === JSON.stringify(rememberedParameters),
  )
  fill(input('经理设定'), '取消的新建不记住')
  await click('.mg-form-foot button[type="button"]')
  await click(`[data-manager-id="${createdId}"] .mg-pick`)
  await until('回到新建的经理', () =>
    one(`[data-manager="session"][data-manager-id="${createdId}"]`),
  )
  await click('[data-sidebar-mode="chat"]')
  const createdKeepsChat = Boolean(
    await until('新建经理不覆盖原对话', () =>
      one('[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *).sel'),
    ),
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
  await tab('runtime')
  const settingsReadOnly =
    document.querySelectorAll('.mg-fixed').length === 5 &&
    !field('工作目录')?.querySelector('input') &&
    !field('首个任务') &&
    !field('从哪种开始')
  await tab('basic')
  fill(editField('名称'), '经理设置验收')
  fill(editField('经理设定'), '修改后的经理设定\n\n保留验收记录。')
  await tab('dispatch')
  fill(editField('最大并行工作线数'), '0')
  await tab('basic')
  await next()
  const settingsValidation = Boolean(
    await until(
      '保存时定位到无效参数页签',
      () => activeStep('dispatch') && one('.mg-form [role="alert"]'),
    ),
  )
  fill(editField('最大并行工作线数'), '5')
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
  await tab('basic')
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
  await tab('dispatch')
  await until('重新打开保存的并发上限', () => editField('最大并行工作线数').value === '5')
  const dispatchSaved =
    field('子会话模型')?.querySelector('select')?.value === lineModel &&
    field('合并方式')?.querySelector('select')?.value === 'user' &&
    [...document.querySelectorAll<HTMLInputElement>('.mg-fields input[type="checkbox"]')].every(
      (input, index) => input.checked === (index !== 0),
    )
  await tab('basic')
  fill(editField('经理设定'), '取消的修改不应保存')
  await click('.mg-form-foot button[type="button"]')
  const settingsCancelled = await until('取消不保存', () =>
    one('.mg-scope')?.textContent?.includes('修改后的经理设定'),
  )
  await click('.sb-top .new')
  await until(
    '编辑与取消不覆盖新建记忆',
    () =>
      one('[data-manager-mode="create"]') &&
      input('经理设定').value === '记住的经理规则' &&
      JSON.stringify(parameterValues()) === JSON.stringify(rememberedParameters),
  )
  await click('.mg-form-foot button[type="button"]')
  await click(`[data-manager-id="${createdId}"] .mg-pick`)
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
  await click('.mg-decision-filter [data-filter="open"]')
  // 同批答复首尾两项，保留中间的待定项；焦点应落到它，栏位和可视区域都留在决策列表。
  for (const id of ['D-17', 'D-12']) {
    fill(
      await until(`${id} 批量答复框`, () =>
        one<HTMLTextAreaElement>(`[data-decision="${id}"] [data-act="manager-answer"]`),
      ),
      '批量答复后继续处理待定决策',
    )
  }
  await until(
    '批量答复可提交',
    () => !one<HTMLButtonElement>('[data-act="manager-submit"]')?.disabled,
  )
  await click('[data-act="manager-submit"]')
  await until('批量答复完成', () => !one('.mg-send'))
  const nextDecision = one('[data-decision="D-16"]')
  const nextBox = nextDecision?.querySelector('header')?.getBoundingClientRect()
  const bodyBox = one('.mg-body')?.getBoundingClientRect()
  const batchKeepsPending = Boolean(
    one('[data-filter="open"][aria-pressed="true"]') &&
      !one('[data-decision="D-17"]') &&
      !one('[data-decision="D-12"]') &&
      document.activeElement === nextDecision &&
      nextBox &&
      bodyBox &&
      nextBox.top >= bodyBox.top &&
      nextBox.bottom <= bodyBox.bottom,
  )
  await click('[data-act="manager-end"]')
  await click('.mg-end button:last-child')
  await until('先进入结束中', () => one('[data-manager-status="ending"]'))
  const endingReadOnly = Boolean(
    one('.mg-title')?.textContent?.includes('结束中') &&
      one('.mg-readonly')?.textContent?.includes('正在收尾') &&
      !one('.mg-title button:not([data-act="manager-board-toggle"])') &&
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
  await click('[data-session="p1"]:not(.projection-group *) [aria-haspopup="menu"]')
  await click('[data-action="archive"]')
  // 归档后目录与投影都应移除。
  await until('已归档的会话从目录移除', () => !one('[data-session="p1"]'))
  await click('[data-sidebar-mode="manager"]')
  await until('归档普通会话不影响经理', () => one('[data-manager="session"][data-manager-id="m1"]'))
  await click('[data-sidebar-mode="chat"]')
  const archivedFallback = Boolean(await until('切回对话默认页', () => one('.new-page')))

  // 比应用旧的设备服务：在本机会话里说“服务旧而忙”，本机在跑的就成了旧版（模拟核心据此不宣告后加的经理能力）
  await click('[data-session="s4"]:not(.projection-group *) .ss-row:not(.projection-group *)')
  const composer = await until('会话输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
  fill(composer, '服务旧而忙，经理冒烟')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  composer.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  await until('这一句发出去', () =>
    [...document.querySelectorAll('.turn .umsg-text')].some((entry) =>
      entry.textContent?.includes('服务旧而忙，经理冒烟'),
    ),
  )
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m3"] .mg-pick')
  await until('旧设备上的经理', () => one('[data-manager="session"][data-manager-id="m3"]'))
  await click('[data-board-tab="decisions"]')
  const banner = await until('设备服务较旧的说明', () => one('[data-old-device]'))
  const oldCard = await until('旧设备上的待定决策', () => one('[data-decision="D-1"]'))
  const oldIgnore = oldCard.querySelector<HTMLButtonElement>('[data-act="manager-ignore"]')
  const oldAsk = oldCard.querySelector<HTMLButtonElement>('[data-act="post-ask"]')
  const oldChecks = {
    banner: Boolean(
      banner.textContent?.includes('设备详情里升级设备服务') &&
        banner.textContent.includes('忽略决策') &&
        banner.textContent.includes('请你做的交付与回复'),
    ),
    ignore: Boolean(oldIgnore?.disabled && oldIgnore.title.includes('升级后可用')),
    ask: Boolean(
      oldAsk?.disabled &&
        oldCard.querySelector('[data-old-device-reason]')?.textContent?.includes('升级后可用'),
    ),
    answered: false,
  }
  fill(
    await until('旧设备上的答复框', () =>
      oldCard.querySelector<HTMLTextAreaElement>('[data-act="manager-answer"]'),
    ),
    '旧设备上照常答复',
  )
  ;(
    await until('旧设备上的提交按钮', () => {
      const button = one<HTMLButtonElement>('[data-act="manager-submit"]')
      return button && !button.disabled ? button : null
    })
  ).click()
  // 最后一条答复后仍在待定，焦点落在列表头；用户手动切栏才能看到已答复。
  await until(
    '旧设备答复后停在空待定栏',
    () =>
      !one('.mg-send') &&
      Boolean(one('[data-filter="open"][aria-pressed="true"]')) &&
      !one('[data-decision="D-1"]') &&
      document.activeElement === one('.mg-decision-filter'),
  )
  await click('.mg-decision-filter [data-filter="answered"]')
  oldChecks.answered = Boolean(
    await until(
      '旧设备上的答复交上',
      () =>
        !one('.mg-send') &&
        one('[data-filter="answered"][aria-pressed="true"]') &&
        one('[data-decision="D-1"]') &&
        !one('[data-decision="D-1"] [data-act="manager-answer"]'),
    ).catch(() => false),
  )
  const oldError = one('.mg-body .err')?.textContent ?? ''
  const oldDevice = Object.values(oldChecks).every(Boolean)
  const oldDeviceDetail = JSON.stringify({ ...oldChecks, error: oldError })
  treeShapeDetail = JSON.stringify({ ...treeShapeSeen, managerLeft, chatLeft })
  return {
    linesState,
    treeShape: treeShape && rootAligned,
    treeShapeDetail,
    pendingTitle,
    answeredSplit: answeredSplit && closedSplit,
    issueOrder: issueOrder && orderInHead,
    previousClosed,
    consoleReports,
    issueRelations,
    managerQuestionDrafts,
    userRequests,
    backgroundQuestions,
    questionForwarded,
    revisedAnswer,
    list,
    selected,
    pendingTooltip,
    draft,
    submitted,
    submitKeepsPending,
    batchKeepsPending,
    turnAdded,
    isolated,
    draftKept,
    reopened,
    managerReopened,
    ignored,
    ignoreDetail,
    endedDraft,
    endedDraftDetail,
    panels,
    childReturn,
    reportsStopped,
    reportsResumed,
    created,
    creationRemembered,
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
    oldDevice,
    oldDeviceDetail,
  }
}

export function judgeManager(seen: ManagerSeen): string[] {
  const messages: Record<
    Exclude<
      keyof ManagerSeen,
      'ignoreDetail' | 'endedDraftDetail' | 'oldDeviceDetail' | 'treeShapeDetail'
    >,
    string
  > = {
    linesState:
      '经理自己只有后台命令、工作线在跑时，经理行仍画成运行中，或没有后台记号、没写明工作线',
    treeShape: `经理一节的树和普通对话的父子树不一致（默认收起、“› N 个子会话”、点开展开；六种外观下工作线标题与记号比经理行多缩进一级、标题列固定、行高一致，经理行与普通对话顶层行左边对齐）：${seen.treeShapeDetail}`,
    pendingTitle: '有待处理的经理行，悬停提示第一行不是“N 待处理 · 状态文字”',
    answeredSplit: '已答复或已关闭的决策没有把答复、关闭记录与问题分块，或其他选项没有默认收起',
    issueOrder:
      '控制台没有默认最新优先，或切换排序后顺序与本机记录不对，或排序不在列表头、决策里仍有待处理优先',
    previousClosed: '重新打开的决策没有收起显示上次关闭的原因',
    managerReopened: '经理重开的决策没有默认展开显示经理写的理由',
    endedDraft: `决策不再待定后草稿仍计数或可提交、卡片没有查看与丢弃，或重开后草稿没有恢复：${seen.endedDraftDetail}`,
    ignored: `忽略决策没有离开待定、单独成组显示理由，或撤销忽略没有回到待定：${seen.ignoreDetail}`,
    consoleReports: '控制台报告与帖子追问未完成',
    issueRelations: '议题关联与编号预览未完成',
    managerQuestionDrafts: '经理追问草稿与回复记录未完成',
    userRequests: '请你做交付未写回',
    backgroundQuestions: '两轮背景问答没有保持在独立线程',
    questionForwarded: '背景问答没有转给经理',
    revisedAnswer: '已答复决策没有保存修改后的答案',
    list: '切换后没有全部经理页',
    selected: '没有打开经理页',
    pendingTooltip: '收起看板按钮与待处理数量未提供相同悬停明细',
    draft: '答复没有标为本地草稿',
    submitted: '答复没有提交到看板',
    submitKeepsPending: '答复后没有留在待定栏，或末条答复后焦点没有回到列表头',
    batchKeepsPending: '批量答复后没有留在待定栏，或下一条待定决策没有获得焦点和保持可见',
    turnAdded: '提交后对话没有新增回合',
    isolated: '经理子会话漏进普通对话目录',
    draftKept: '切换经理后草稿丢失',
    reopened: '已关闭决策没有重新打开',
    panels: '事项或工作线没有显示事实',
    childReturn: '子会话没有返回经理',
    reportsStopped: '经理子会话停止回报后没有显示标记',
    reportsResumed: '经理子会话恢复回报后标记没有移除',
    created: '新建经理没有进入经理页',
    creationRemembered: '再次新建经理没有预填上次成功创建的参数，或名称、首个任务没有留空',
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
    oldDevice: `设备服务比应用旧时，控制台没写明不可用的功能与升级去处、忽略或追问没禁用写原因，或决策答复交不上：${seen.oldDeviceDetail}`,
  }
  return (Object.keys(messages) as (keyof typeof messages)[])
    .filter((key) => !seen[key])
    .map((key) => messages[key])
}
