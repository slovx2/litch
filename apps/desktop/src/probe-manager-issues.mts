// 默认 issue 控制台的 Electron 冒烟。只操作正式界面，数据与延迟回复走模拟核心和消息端口。
// 不依赖状态过滤器的具体控件形态；概览过滤用首屏读到的卡片集合交叉核对。
export async function managerIssuesProbe() {
  const passed: string[] = []
  const one = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)
  const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  const cards = () => all('[data-issue-type]')
  const total = () =>
    one('[data-issue-total]')
      ?.textContent?.match(/\d+\s*\/\s*\d+/)?.[0]
      .replace(/\s/g, '')
  const assert = (ok: unknown, message: string) => {
    if (!ok) throw new Error(`issue 冒烟：${message}；已通过 ${passed.join('、')}`)
  }
  const until = async <T,>(what: string, read: () => T | null | undefined | false): Promise<T> => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      const value = read()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(
      `issue 冒烟等待超时：${what}；${JSON.stringify({
        passed,
        total: total(),
        cards: cards().map((card) => card.dataset.issue),
        threads: all('[data-issue-thread]').map((thread) => thread.dataset.issueThread),
        errors: all('[role="alert"]').map((alert) => alert.textContent),
      })}`,
    )
  }
  const click = async (selector: string) => {
    const button = await until(selector, () => {
      const element = one<HTMLButtonElement>(selector)
      return element && !element.matches(':disabled') ? element : null
    })
    button.click()
  }
  const fill = async (selector: string, value: string) => {
    const input = await until(selector, () => one<HTMLInputElement | HTMLTextAreaElement>(selector))
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const select = async (selector: string, value: string) => {
    const input = await until(selector, () => {
      const element = one<HTMLSelectElement>(selector)
      return element && !element.disabled ? element : null
    })
    assert(
      [...input.options].some((option) => option.value === value),
      `${selector} 缺少 ${value}`,
    )
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const sameIds = (expected: string[]) =>
    JSON.stringify(
      cards()
        .map((card) => card.dataset.issue)
        .sort(),
    ) === JSON.stringify([...expected].sort())

  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] [data-session] > button')
  await until('默认控制台选中', () => one('[data-board-tab="inbox"][aria-selected="true"]'))
  await until(
    '默认决策标签选中',
    () =>
      one('[data-inbox-tab="decisions"][aria-pressed="true"]') &&
      cards().length &&
      cards().every((card) => card.dataset.issueType === 'decision'),
  )
  assert(
    all('[data-inbox-tab]')
      .map((tab) => tab.dataset.inboxTab)
      .join(',') === 'decisions,suggestions,requests,reports,issues',
    '控制台分类标签不完整或顺序错误',
  )
  assert(
    !one('[data-act="issue-new"]') && !one('[data-issue-chip]'),
    '决策标签出现X-n issue 专属操作',
  )
  passed.push('五类标签、默认决策、专属操作隔离')
  await click('[data-inbox-tab="issues"]')
  await until('X-n issue 首屏 30/38', () => total() === '30/38' && cards().length === 30)
  assert(
    cards().every((card) => card.dataset.issueType === 'ordinary'),
    'X-n issue 标签混入特殊 issue',
  )
  assert(
    one('[data-act="issue-new"]') && all('[data-issue-chip]').length === 4,
    'X-n issue 缺少新建或过滤胶囊',
  )
  assert(one('[data-issue-more]'), '首屏没有加载更多')
  passed.push('X-n issue 标签：30/38')
  await click('[data-issue-more]')
  await until('全部 38 条', () => total() === '38/38' && cards().length === 38)
  assert(!one('[data-issue-more]'), '加载完仍有下一页')
  assert(new Set(cards().map((card) => card.dataset.issue)).size === 38, '分页出现重复卡片')
  passed.push('加载更多：38/38 且无重复')

  // issue 页签的多选过滤只纳入已开启讨论的特殊条目；四类独立页签仍完整。
  await click('[data-issue-filter-kind="all"]')
  await until('已讨论的四类特殊 issue', () =>
    ['decision', 'suggestion', 'request', 'report'].every((kind) =>
      cards().some((card) => card.dataset.issueType === kind),
    ),
  )
  const discussions = new Set(
    cards()
      .filter((card) => card.dataset.issueType !== 'ordinary')
      .map((card) => card.dataset.issue),
  )
  await click('[data-inbox-tab="decisions"]')
  await until(
    '决策完整列表',
    () => cards().length > 0 && cards().every((card) => card.dataset.issueType === 'decision'),
  )
  const unopened = cards().find((card) => !discussions.has(card.dataset.issue))
  assert(unopened, '应有尚未讨论的决策用于验证入口')
  const unopenedId = unopened?.dataset.issue
  await click(`[data-issue="${unopenedId}"] [data-act="issue-toggle"]`)
  await click(`[data-issue="${unopenedId}"] [data-act="issue-discuss"]`)
  await until('开启讨论持久化', () => one('[data-issue-thread="pane"]'))
  await click('[data-inbox-tab="issues"]')
  await until(
    '全选条件独立记忆且新讨论出现',
    () =>
      one('[data-issue-filter-kind="all"][aria-pressed="true"]') &&
      cards().some((card) => card.dataset.issue === unopenedId),
  )
  // 恢复默认 X-n，后续计数以完整原始集合为准。
  for (const kind of ['decision', 'suggestion', 'request', 'report'])
    await click(`[data-issue-filter-kind="${kind}"]`)
  await until('恢复默认 issue 首屏', () => total() === '30/38')
  await click('[data-issue-more]')
  await until('恢复完整 X-n 集合', () => total() === '38/38')
  passed.push('类型多选、全选、独立记忆和开启讨论后纳入 issue')

  // 从完整列表的可见元信息得出期待集合，避免拿产品过滤函数给自身作断言。
  const samples = cards().map((card) => ({
    id: card.dataset.issue ?? '',
    status: card.querySelector<HTMLElement>('[data-issue-status]')?.dataset.issueStatus,
    unread: card.dataset.unread === 'true',
    paused: Boolean(card.querySelector('[data-follow="off"]')),
  }))
  const active = (status: string | undefined) =>
    ['open', 'in_progress', 'blocked'].includes(status ?? '')
  const expectedSummary = {
    active: samples.filter((sample) => active(sample.status)).map((sample) => sample.id),
    unread: samples.filter((sample) => sample.unread).map((sample) => sample.id),
    paused: samples
      .filter((sample) => active(sample.status) && sample.paused)
      .map((sample) => sample.id),
  }
  // 两个标签各留不同的状态与排序，切换回来仍取自己的过滤条件。
  await click('[data-issue-filter-status="active"]')
  await select('[data-issue-filter="order"]', 'oldest')
  await until('X-n issue 开放集合', () => sameIds(expectedSummary.active))
  await click('[data-inbox-tab="decisions"]')
  await click('[data-issue-filter-status="open"]')
  await select('[data-issue-filter="order"]', 'updated')
  await until(
    '决策待处理集合',
    () =>
      cards().length &&
      cards().every(
        (item) =>
          item.dataset.issueType === 'decision' &&
          item.querySelector('[data-issue-meta] [data-issue-status="open"]'),
      ),
  )
  await click('[data-inbox-tab="issues"]')
  await until(
    'X-n issue 独立记忆',
    () =>
      one('[data-issue-filter-status="active"][aria-pressed="true"]') &&
      one<HTMLSelectElement>('[data-issue-filter="order"]')?.value === 'oldest' &&
      sameIds(expectedSummary.active),
  )
  await click('[data-inbox-tab="decisions"]')
  await until(
    '决策独立记忆',
    () =>
      one('[data-issue-filter-status="open"][aria-pressed="true"]') &&
      one<HTMLSelectElement>('[data-issue-filter="order"]')?.value === 'updated',
  )
  passed.push('分类标签独立记忆状态与排序')
  for (const [key, expected] of Object.entries(expectedSummary)) {
    // 从决策标签进入概览，数字应切到X-n issue 并覆盖它之前记住的过滤条件。
    await click('[data-inbox-tab="decisions"]')
    await until(
      '切到决策列表',
      () => cards().length && cards().every((card) => card.dataset.issueType === 'decision'),
    )
    await click('[data-board-tab="overview"]')
    const summary = `[data-overview-issues="${key}"]`
    await until(
      `概览 ${key} 数字`,
      () =>
        one(summary)
          ?.textContent?.match(/\d+\s*$/)?.[0]
          ?.trim() === String(expected.length),
    )
    await click(summary)
    await until(
      `概览 ${key} 过滤集合一致`,
      () => total() === `${expected.length}/${expected.length}` && sameIds(expected),
    )
    assert(
      cards().every((card) => card.dataset.issueType === 'ordinary'),
      `${key} 混入特殊 issue`,
    )
    assert(one('[data-inbox-tab="issues"][aria-pressed="true"]'), '概览没有切到X-n issue 标签')
    assert(
      one<HTMLSelectElement>('[data-issue-filter="order"]')?.value === 'newest',
      '概览仍沿用先前排序',
    )
    if (key === 'unread')
      assert(one('[data-issue-chip="unread"][aria-pressed="true"]'), '未读过滤没有提示')
    passed.push(`概览 ${key}：${expected.length} 条与列表一致`)
  }
  await click('[data-issue-filter-status="all"]')
  await click('[data-issue-chip="paused"]')
  await until(
    '重置默认列表',
    () =>
      total()?.endsWith('/38') && cards().every((card) => card.dataset.issueType === 'ordinary'),
  )

  await click('[data-act="issue-new"]')
  await click('[data-act="issue-create"]')
  await until('空标题被拒绝', () => one('[data-issue-title][aria-invalid="true"]'))
  assert(
    one('[data-issue-form] [role="alert"]')?.textContent?.includes('标题必填'),
    '缺少标题必填说明',
  )
  assert(total()?.endsWith('/38'), '空标题创建了 issue')
  await fill('[data-issue-title]', '   ')
  await click('[data-act="issue-create"]')
  assert(one('[data-issue-title][aria-invalid="true"]'), '空白标题未被拒绝')
  const title = '桌面冒烟：跟进远程会话恢复'
  const body = '重启后应恢复会话，后续在这里补充验收结果。'
  await fill('[data-issue-title]', title)
  await fill('[data-issue-body]', body)
  await click('[data-act="issue-create"]')
  const created = await until('新 issue 展开', () =>
    cards().find(
      (card) =>
        card.textContent?.includes(title) && card.querySelector('[data-issue-thread="inline"]'),
    ),
  )
  const id = created.dataset.issue ?? ''
  const card = `[data-issue-type="ordinary"][data-issue="${CSS.escape(id)}"]`
  await until('新建后的总数', () => total()?.endsWith('/39'))
  assert(
    !one('[data-issue-form]') && created.textContent?.includes(body),
    '新建后表单未关或正文丢失',
  )
  passed.push('标题必填、空白拒绝、新建并展开')

  const comment = '请核实重启时的恢复顺序。'
  await fill(`${card} [data-issue-comment-input]`, comment)
  const sentAt = performance.now()
  await click(`${card} [data-act="issue-comment"]`)
  await until('用户评论落时间线', () =>
    one(`${card} [data-timeline="comment"][data-author="user"]`)?.textContent?.includes(comment),
  )
  await until(
    '评论输入清空',
    () => one<HTMLTextAreaElement>(`${card} [data-issue-comment-input]`)?.value === '',
  )
  // 收起后再等异步回复，避免展开卡自动已读，让未读状态有可观察的窗口。
  await click(`${card} [data-act="issue-toggle"]`)
  await until('评论后收起', () => !one(`${card} [data-issue-thread]`))
  assert(!one(`${card}[data-unread="true"]`), '模拟回复提前到达')
  await until('延迟经理回复标未读', () => one(`${card}[data-unread="true"]`))
  const replyAfterMs = Math.round(performance.now() - sentAt)
  // 定时器是 2.5 秒；上限由等待超时保护，不把繁忙机器的帧调度当精确计时测试。
  assert(replyAfterMs >= 2000, `回复未等待约 2.5 秒：${replyAfterMs}ms`)
  await click(`${card} [data-act="issue-toggle"]`)
  await until('经理回复正文', () =>
    one(`${card} [data-timeline="comment"][data-author="manager"]`)?.textContent?.includes(
      '收到。我先看一下现状',
    ),
  )
  await until('打开后已读', () => one(card) && !one(`${card}[data-unread="true"]`))
  passed.push('评论、延迟经理回复、未读与打开后已读')

  await click(`${card} [data-issue-status-select] [data-issue-status="in_progress"]`)
  await until('状态原因进时间线', () =>
    all(`${card} [data-timeline="event"]`).some((event) =>
      event.textContent?.includes('状态改为 进行中'),
    ),
  )
  assert(one(`${card} [data-issue-meta] [data-issue-status="in_progress"]`), '状态元信息未更新')
  await click(`${card} [data-act="issue-follow"]`)
  await until('暂停跟进原因进时间线', () =>
    all(`${card} [data-timeline="event"]`).some((event) => event.textContent?.includes('暂停跟进')),
  )
  assert(
    one(`${card} [data-follow="off"]`) && one(`${card} [data-follow-note]`),
    '暂停跟进未显示状态与提示',
  )
  assert(
    one(`${card} [data-act="issue-follow"]`)?.getAttribute('aria-checked') === 'false',
    '跟进按钮仍在开启状态',
  )
  passed.push('状态、暂停跟进与原因时间线')

  await click('[data-inbox-tab="decisions"]')
  await until(
    '决策过滤',
    () => cards().length && cards().every((item) => item.dataset.issueType === 'decision'),
  )
  const decisionIds = cards().map((item) => item.dataset.issue ?? '')
  const decisionId = decisionIds[0] ?? ''
  const decision = `[data-issue-type="decision"][data-issue="${CSS.escape(decisionId)}"]`
  await click(`${decision} [data-act="issue-toggle"]`)
  await until('决策快速处理区', () => one(`${decision} [data-paging-detail]`))
  await click(`${decision} [data-act="issue-discuss"]`)
  await until('底部讨论抽屉', () => one('[data-issue-thread="pane"] [data-issue-comment-input]'))
  assert(one('[data-issue-thread="pane"]')?.dataset.issue === decisionId, '抽屉打开了别的 issue')
  assert(one(decision) && !one('[data-issue-thread="page"]'), '抽屉替换了列表')
  await click('[data-issue-thread="pane"] [data-act="issue-full"]')
  await until('完整讨论页', () => one('[data-issue-thread="page"]')?.dataset.issue === decisionId)
  assert(!one('[data-issue-thread="pane"]') && cards().length === 0, '整页还保留抽屉或列表')
  await click('[data-act="issue-back"]')
  await until(
    '返回同一过滤列表和展开卡',
    () =>
      sameIds(decisionIds) && one(`${decision} [data-act="issue-toggle"][aria-expanded="true"]`),
  )
  assert(!one('[data-issue-thread="page"]'), '返回后仍停在整页')
  passed.push('决策快速处理、抽屉、完整讨论与返回')
  return {
    passed,
    createdId: id,
    replyAfterMs,
    summary: Object.fromEntries(
      Object.entries(expectedSummary).map(([key, ids]) => [key, ids.length]),
    ),
  }
}
